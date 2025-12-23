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
    
    logger.info(`Found funder: ${funder.company_name}`);
    
    // Extract broker domain from sender
    const senderEmail = emailData.From || emailData.FromFull?.Email;
    const brokerDomain = senderEmail.split('@')[1];
    
    logger.info(`Broker domain: ${brokerDomain}`);
    
    // Check if there are attachments
    const attachments = emailData.Attachments || [];
    
    if (attachments.length === 0) {
      logger.warn('No attachments found in email');
      return res.status(200).json({ message: 'No attachments to process' });
    }
    
    logger.info(`Processing ${attachments.length} attachment(s)`);
    
    // Process each attachment through the watermarking API
    const watermarkedAttachments = [];
    
    for (const attachment of attachments) {
      try {
        // Get logo from Supabase Storage
        const { data: logoData } = supabase.storage
          .from('gateway-logos')
          .getPublicUrl(funder.logo_storage_path);
        
        const logoUrl = logoData.publicUrl;
        
        // Prepare watermarking request
        const watermarkPayload = {
          funderId: funderId,
          logoUrl: logoUrl,
          brokerDomain: brokerDomain,
          fileName: attachment.Name,
          fileContent: attachment.Content // Base64 from Postmark
        };
        
        // Call your Funder API
        const watermarkResponse = await fetch(process.env.FUNDER_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': process.env.FUNDER_API_KEY
          },
          body: JSON.stringify(watermarkPayload)
        });
        
        if (!watermarkResponse.ok) {
          throw new Error(`Watermarking failed: ${watermarkResponse.statusText}`);
        }
        
        const watermarkedFile = await watermarkResponse.json();
        
        watermarkedAttachments.push({
          Name: attachment.Name,
          Content: watermarkedFile.content, // Base64
          ContentType: attachment.ContentType
        });
        
        logger.info(`Successfully watermarked: ${attachment.Name}`);
        
      } catch (error) {
        logger.error(`Error watermarking ${attachment.Name}:`, error);
        // Continue processing other attachments
      }
    }
    
    if (watermarkedAttachments.length === 0) {
      logger.error('No attachments were successfully watermarked');
      return res.status(500).json({ error: 'Watermarking failed for all attachments' });
    }
    
    // Send email with watermarked attachments
    logger.info(`Sending email to: ${funder.destination_email}`);
    
    await postmarkClient.sendEmail({
      From: senderEmail,
      To: funder.destination_email,
      Subject: 'New Submission',
      TextBody: '', // Empty body as requested
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
