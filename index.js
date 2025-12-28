const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const { createClient } = require('@supabase/supabase-js');
const postmark = require('postmark');
const fetch = require('node-fetch');

// Initialize logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Initialize Express
const app = express();
const PORT = process.env.PORT || 10000;

// Security and middleware
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/webhook', limiter);

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Initialize Postmark client for sending
const postmarkClient = new postmark.ServerClient(process.env.POSTMARK_API_KEY);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'aquamark-email-gateway' });
});

// Main webhook endpoint
app.post('/webhook/inbound', async (req, res) => {
  try {
    logger.info('Received inbound email webhook');
    
    const emailData = req.body;
    
    // Extract funder ID from recipient address (e.g., test1@gateway.aquamark.io -> test1)
    const recipientEmail = emailData.ToFull?.[0]?.Email || emailData.To;
    const funderId = recipientEmail.split('@')[0];
    
    logger.info(`Processing email for funder: ${funderId}`);
    
    // Look up funder configuration
    const { data: funder, error: funderError } = await supabase
      .from('email_gateway_funders')
      .select('*')
      .eq('funder_id', funderId)
      .eq('active', true)
      .single();
    
    if (funderError || !funder) {
      logger.error(`Funder not found or inactive: ${funderId}`);
      return res.status(404).json({ error: 'Funder not found' });
    }
    
    logger.info(`Found funder: ${funder.company_name}, user_email: ${funder.user_email}`);
    
    // Extract broker name from sender
    const senderEmail = emailData.From || emailData.FromFull?.Email;
    const senderName = emailData.FromName || emailData.FromFull?.Name || senderEmail.split('@')[0];
    
    logger.info(`Broker: ${senderName} (${senderEmail})`);
    
    // Check if there are attachments
    const attachments = emailData.Attachments || [];
    
    if (attachments.length === 0) {
      logger.warn('No attachments found in email');
      return res.status(200).json({ message: 'No attachments to process' });
    }
    
    logger.info(`Processing ${attachments.length} attachment(s)`);
    
    // Process each attachment through the watermarking API
    const watermarkedAttachments = [];
    const tempFiles = []; // Track temp files for cleanup
    
    for (const attachment of attachments) {
      try {
        // Only process PDF files
        if (!attachment.Name.toLowerCase().endsWith('.pdf')) {
          logger.warn(`Skipping non-PDF file: ${attachment.Name}`);
          continue;
        }
        
        // Upload file to temporary storage
        const tempFileName = `temp/${Date.now()}-${attachment.Name}`;
        const fileBuffer = Buffer.from(attachment.Content, 'base64');
        
        const { data: uploadData, error: uploadError } = await supabase.storage
          .from('funder-logos')
          .upload(tempFileName, fileBuffer, {
            contentType: attachment.ContentType,
            upsert: false
          });
        
        if (uploadError) {
          throw new Error(`Failed to upload temp file: ${uploadError.message}`);
        }
        
        tempFiles.push(tempFileName);
        
        // Get public URL for the temp file
        const { data: urlData } = supabase.storage
          .from('funder-logos')
          .getPublicUrl(tempFileName);
        
        let fileUrl = urlData.publicUrl;
        
        // Ensure absolute URL
        if (!fileUrl.startsWith('http')) {
          fileUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/funder-logos/${tempFileName}`;
        }
        
        logger.info(`File URL for API: ${fileUrl}`);
        
        // Call Funder API with correct parameters
        const watermarkPayload = {
          user_email: funder.user_email,
          file_url: fileUrl,
          broker_name: senderName
        };
        
        logger.info(`Calling Funder API with payload:`, watermarkPayload);
        
        const watermarkResponse = await fetch(process.env.FUNDER_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.FUNDER_API_KEY}`
          },
          body: JSON.stringify(watermarkPayload)
        });
        
        if (!watermarkResponse.ok) {
          const errorText = await watermarkResponse.text();
          throw new Error(`Watermarking failed: ${watermarkResponse.status} - ${errorText}`);
        }
        
        const watermarkedFile = await watermarkResponse.json();
        
        // Download watermarked file from returned URL
        const watermarkedFileResponse = await fetch(watermarkedFile.file_url);
        const watermarkedBuffer = await watermarkedFileResponse.arrayBuffer();
        const watermarkedBase64 = Buffer.from(watermarkedBuffer).toString('base64');
        
        watermarkedAttachments.push({
          Name: attachment.Name,
          Content: watermarkedBase64,
          ContentType: 'application/pdf'
        });
        
        logger.info(`Successfully watermarked: ${attachment.Name}`);
        
      } catch (error) {
        logger.error(`Error watermarking ${attachment.Name}:`, error);
        // Continue processing other attachments
      }
    }
    
    // Clean up temporary files
    for (const tempFile of tempFiles) {
      try {
        await supabase.storage
          .from('funder-logos')
          .remove([tempFile]);
        logger.info(`Cleaned up temp file: ${tempFile}`);
      } catch (error) {
        logger.warn(`Failed to clean up temp file ${tempFile}:`, error);
      }
    }
    
    if (watermarkedAttachments.length === 0) {
      logger.error('No attachments were successfully watermarked');
      return res.status(500).json({ error: 'Watermarking failed for all attachments' });
    }
    
    // Send email with watermarked attachments from verified domain
    logger.info(`Sending email to: ${funder.destination_email}`);
    
    await postmarkClient.sendEmail({
      From: 'gateway@aquamark.io',
      ReplyTo: senderEmail,
      To: funder.destination_email,
      Subject: `New Submission - ${funder.company_name}`,
      TextBody: `Submitted by: ${senderName} (${senderEmail})`,
      Attachments: watermarkedAttachments
    });
    
    logger.info('Email sent successfully');
    
    res.json({ 
      success: true, 
      message: 'Email processed and forwarded',
      attachments: watermarkedAttachments.length
    });
    
  } catch (error) {
    logger.error('Error processing webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Email gateway service running on port ${PORT}`);
});
