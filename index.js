const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const { createClient } = require('@supabase/supabase-js');
const postmark = require('postmark');
const fetch = require('node-fetch');
const AdmZip = require('adm-zip');

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
    
    // Extract original email subject and body
    const originalSubject = emailData.Subject || 'New Submission';
    const originalBody = emailData.TextBody || emailData.HtmlBody || '';
    
    // Extract broker domain from sender email (better attribution than sender name)
    const senderEmail = emailData.From || emailData.FromFull?.Email;
    const brokerDomain = senderEmail.split('@')[1];
    
    logger.info(`Sender: ${senderEmail}, Broker domain: ${brokerDomain}`);
    
    // Check if there are attachments
    const attachments = emailData.Attachments || [];
    
    if (attachments.length === 0) {
      logger.warn('No attachments found in email');
      return res.status(200).json({ message: 'No attachments to process' });
    }
    
    // Filter to PDF attachments only
    const pdfAttachments = attachments.filter(att => 
      att.Name.toLowerCase().endsWith('.pdf')
    );
    
    if (pdfAttachments.length === 0) {
      logger.warn('No PDF attachments found in email');
      return res.status(200).json({ message: 'No PDF attachments to process' });
    }
    
    logger.info(`Processing ${pdfAttachments.length} PDF attachment(s)`);
    
    // Prepare files array for Funder API (new format preserves filenames)
    const files = pdfAttachments.map(att => ({
      name: att.Name,
      data: att.Content // Postmark already provides base64
    }));
    
    try {
      logger.info(`Sending ${files.length} file(s) to watermarking API`);
      
      // Call Funder API with files array
      const watermarkPayload = {
        user_email: funder.user_email,
        broker_name: brokerDomain,
        files: files
      };
      
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
        throw new Error(`Watermarking API failed (${watermarkResponse.status}): ${errorText}`);
      }
      
      const result = await watermarkResponse.json();
      
      // Check job status and wait for completion
      const jobId = result.job_id;
      logger.info(`Job created: ${jobId}, polling for completion...`);
      
      // Poll job status (max 30 seconds)
      let attempts = 0;
      let jobCompleted = false;
      let downloadUrl = null;
      
      while (attempts < 15 && !jobCompleted) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
        
        const statusResponse = await fetch(`${process.env.FUNDER_API_URL.replace('/watermark-funder-broker', '')}/job-status/${jobId}`, {
          headers: {
            'Authorization': `Bearer ${process.env.FUNDER_API_KEY}`
          }
        });
        
        if (statusResponse.ok) {
          const status = await statusResponse.json();
          logger.info(`Job ${jobId} status: ${status.status}`);
          
          if (status.status === 'completed') {
            jobCompleted = true;
            downloadUrl = status.download_url;
          } else if (status.status === 'failed') {
            throw new Error(`Watermarking job failed: ${status.error_message}`);
          }
        }
        
        attempts++;
      }
      
      if (!jobCompleted) {
        throw new Error('Watermarking job timed out');
      }
      
      // Download watermarked ZIP
      logger.info(`Downloading watermarked file from: ${downloadUrl}`);
      const downloadResponse = await fetch(downloadUrl);
      
      if (!downloadResponse.ok) {
        throw new Error(`Failed to download watermarked file: ${downloadResponse.statusText}`);
      }
      
      const watermarkedBuffer = await downloadResponse.arrayBuffer();
      
      // Unzip to extract individual PDFs
      const zip = new AdmZip(Buffer.from(watermarkedBuffer));
      const zipEntries = zip.getEntries();
      
      // Extract each PDF as a separate attachment
      const watermarkedAttachments = zipEntries
        .filter(entry => !entry.isDirectory && entry.entryName.toLowerCase().endsWith('.pdf'))
        .map(entry => ({
          Name: entry.entryName,
          Content: entry.getData().toString('base64'),
          ContentType: 'application/pdf'
        }));
      
      if (watermarkedAttachments.length === 0) {
        throw new Error('No PDF files found in watermarked ZIP');
      }
      
      logger.info(`Extracted ${watermarkedAttachments.length} watermarked PDF(s) from ZIP`);
      
      // Send email with watermarked attachments
      logger.info(`Sending email to: ${funder.destination_email}`);
      
      await postmarkClient.sendEmail({
        From: 'Aquamark <gateway@aquamark.io>',
        ReplyTo: senderEmail,
        To: funder.destination_email,
        Subject: originalSubject,
        TextBody: originalBody,
        Attachments: watermarkedAttachments
      });
      
      logger.info('Email sent successfully');
      
      res.json({ 
        success: true, 
        message: 'Email processed and forwarded',
        files_processed: files.length
      });
      
    } catch (error) {
      logger.error(`Error during watermarking/sending process:`, error.message);
      return res.status(500).json({ error: `Processing failed: ${error.message}` });
    }
    
  } catch (error) {
    logger.error('Error processing webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Email gateway service running on port ${PORT}`);
});
