require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Storage } = require('@google-cloud/storage');
const { VideoIntelligenceServiceClient } = require('@google-cloud/video-intelligence');
const { OpenAI } = require('openai');

const app = express();
const port = process.env.PORT || 3000;
const keyPath = path.join(__dirname, 'keyfile.json');

// Health Check
app.get('/health', (req, res) => res.send('✅ Server is up'));

// === Decode base64 service account key ===
if (!process.env.GOOGLE_KEY_BASE64) {
  console.error('❌ GOOGLE_KEY_BASE64 not found in .env');
  process.exit(1);
}

let storage, videoClient;

try {
const rawBase64 = process.env.GOOGLE_KEY_BASE64
  .trim()
  .replace(/^['"]+|['"]+$/g, ''); // Strip outer quotes

const decoded = Buffer.from(rawBase64, 'base64').toString('utf8');
const parsed = JSON.parse(decoded);

// 🔐 Fix newline characters in private_key
if (parsed.private_key) {
  parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
}

// 💾 Save fixed keyfile
fs.writeFileSync(keyPath, JSON.stringify(parsed, null, 2));

// ✅ Initialize Google Cloud clients
storage = new Storage({ keyFilename: keyPath });
videoClient = new VideoIntelligenceServiceClient({ keyFilename: keyPath });

console.log('✅ Google Cloud clients initialized:', parsed.client_email);
} catch (err) {
  console.error('❌ GOOGLE_KEY_BASE64 decode failed:', err.message);
  process.exit(1);
}

// OpenAI setup
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Multer setup for 5 GB limit
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5 GB
});
let lastUploadedFile = '';

// Upload Endpoint
app.post('/upload-video', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('❌ No file uploaded');

    lastUploadedFile = req.file.filename;
    const localFilePath = path.join(__dirname, 'uploads', lastUploadedFile);
    const bucket = storage.bucket('basketball-demo-videos');

    await bucket.upload(localFilePath, { destination: lastUploadedFile });

    console.log(`✅ Uploaded: ${lastUploadedFile}`);
    res.send('✅ Video uploaded successfully.');
  } catch (err) {
    console.error('❌ Upload error:', err);
    res.status(500).send('❌ Upload failed');
  }
});

// Analyze Video
app.get('/analyze-video', async (req, res) => {
  try {
    if (!lastUploadedFile) return res.status(400).send('❌ No video uploaded.');

    const gcsUri = `gs://basketball-demo-videos/${lastUploadedFile}`;
    const [operation] = await videoClient.annotateVideo({
      inputUri: gcsUri,
      features: ['LABEL_DETECTION', 'SHOT_CHANGE_DETECTION', 'TEXT_DETECTION', 'OBJECT_TRACKING'],
    });

    console.log('🕒 Analyzing...');
    const [result] = await operation.promise({ timeout: 600000 });
    const annotations = result.annotationResults[0];
    fs.writeFileSync('metadata.json', JSON.stringify(annotations, null, 2));

    res.send('✅ Video analysis complete.');
  } catch (err) {
    console.error('❌ Analysis error:', err);
    res.status(500).send('❌ Analysis failed: ' + err.message);
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
    const prompt = `Based on this video metadata:\n${labels}\n\nQuestion: ${question}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a basketball analyst AI.' },
        { role: 'user', content: prompt },
      ],
    });

    res.send(response.choices[0].message.content);
  } catch (err) {
    console.error('❌ Chat error:', err.message);
    res.status(500).send('OpenAI failed: ' + err.message);
  }
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
