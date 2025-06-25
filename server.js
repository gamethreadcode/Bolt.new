require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Storage } = require('@google-cloud/storage');
const { VideoIntelligenceServiceClient } = require('@google-cloud/video-intelligence');
const { OpenAI } = require('openai');

const app = express();
const port = 3000;
// === Decode base64 service account key to keyfile.json ===
const keyPath = path.join(__dirname, 'keyfile.json');

if (process.env.GOOGLE_KEY_BASE64) {
  const decoded = Buffer.from(process.env.GOOGLE_KEY_BASE64, 'base64').toString('utf8');
  fs.writeFileSync(keyPath, decoded);
} else {
  console.error('❌ GOOGLE_KEY_BASE64 not found in .env');
  process.exit(1);
}

// === Setup Google Cloud clients ===
const storage = new Storage({ keyFilename: keyPath });
const videoClient = new VideoIntelligenceServiceClient({ keyFilename: keyPath });

// OpenAI setup
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Multer setup for file upload
const upload = multer({ dest: 'uploads/' });
let lastUploadedFile = ''; // Stores the last uploaded filename

// Upload endpoint
app.post('/upload-video', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('No file uploaded.');

    lastUploadedFile = req.file.filename;
    const localFilePath = path.join(__dirname, 'uploads', lastUploadedFile);
    const bucket = storage.bucket('basketball-demo-videos');

    await bucket.upload(localFilePath, {
      destination: lastUploadedFile,
    });

    console.log(`${lastUploadedFile} uploaded to Google Cloud Storage`);
    res.send('✅ Video uploaded successfully.');
  } catch (err) {
    console.error('Upload Error:', err);
    res.status(500).send('Upload failed');
  }
});

app.get('/analyze-video', async (req, res) => {
  try {
    if (!lastUploadedFile) {
      return res.status(400).send('❌ No video uploaded yet.');
    }

    const gcsUri = `gs://basketball-demo-videos/${lastUploadedFile}`;
    console.log('🔍 Analyzing:', gcsUri);

    // Step 1: Call Google Video Intelligence API
    const [operation] = await videoClient.annotateVideo({
      inputUri: gcsUri,
      features: [
        'LABEL_DETECTION',
        'SHOT_CHANGE_DETECTION',
        'TEXT_DETECTION',
        'OBJECT_TRACKING',
      ],
    });

    console.log("🕒 Waiting for analysis to complete... (This may take up to 10 mins)");

    // Step 2: Wait for the result with an extended timeout (10 mins)
    const [result] = await operation.promise({ timeout: 60000000 }); // 600 sec = 10 min

    // Step 3: Extract and save metadata
    const annotations = result.annotationResults[0];
    fs.writeFileSync('metadata.json', JSON.stringify(annotations, null, 2));
    console.log('✅ Metadata saved to metadata.json');

    res.send('✅ Video analysis complete and metadata saved.');
  } catch (err) {
    console.error('❌ Error during video analysis:', err.message);
    res.status(500).send('❌ Failed to analyze video: ' + err.message);
  }
});

// Chat endpoint
app.get('/chat', async (req, res) => {
  try {
    const raw = fs.readFileSync('metadata.json', 'utf-8');
    const metadata = JSON.parse(raw);

    const labels = metadata.segmentLabelAnnotations
      ?.slice(0, 5)
      .map(l => `${l.entity.description}: ${l.segments.length} segments`)
      .join('\n');

    const question = req.query.q || 'Summarize key plays from the video.';

    const prompt = `
Based on this video metadata:
${labels}

Question: ${question}
    `;

    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a basketball analyst AI.' },
        { role: 'user', content: prompt },
      ],
    });

    res.send(response.choices[0].message.content);
  } catch (err) {
    console.error('Chat Error:', err);
    res.status(500).send('OpenAI chat failed: ' + err.message);
  }
});

// Run server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
