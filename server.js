// server.js
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { Storage } = require('@google-cloud/storage');
const { VideoIntelligenceServiceClient } = require('@google-cloud/video-intelligence');
const { OpenAI } = require('openai');
const admin = require('firebase-admin');

const app = express();
const port = process.env.PORT || 3000;
const keyPath = path.join(__dirname, 'keyfile.json');

app.use(cors());
app.use(express.json()); // To handle JSON bodies (project data)

// === Firebase Setup ===
const firebaseKeyDecoded = Buffer.from(process.env.FIREBASE_KEY_BASE64, 'base64').toString('utf8');
const firebaseCreds = JSON.parse(firebaseKeyDecoded);
admin.initializeApp({ credential: admin.credential.cert(firebaseCreds) });
const db = admin.firestore();

// === Health Check ===
app.get('/health', (req, res) => res.send('✅ Server is up'));

// === Decode Google Key ===
if (!process.env.GOOGLE_KEY_BASE64) {
  console.error('❌ GOOGLE_KEY_BASE64 not found in .env');
  process.exit(1);
}

let storage, videoClient;

try {
  const rawBase64 = process.env.GOOGLE_KEY_BASE64.trim().replace(/^['"]+|['"]+$/g, '');
  const decoded = Buffer.from(rawBase64, 'base64').toString('utf8');
  const parsed = JSON.parse(decoded);

  if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  fs.writeFileSync(keyPath, JSON.stringify(parsed, null, 2));

  storage = new Storage({ keyFilename: keyPath });
  videoClient = new VideoIntelligenceServiceClient({ keyFilename: keyPath });

  console.log('✅ Google Cloud clients initialized:', parsed.client_email);
} catch (err) {
  console.error('❌ GOOGLE_KEY_BASE64 decode failed:', err.message);
  process.exit(1);
}

// === OpenAI Setup ===
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// === Multer Setup (up to 5GB files) ===
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 5 * 1024 * 1024 * 1024 },
});

// === Upload Endpoint ===
app.post('/upload-video', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('❌ No file uploaded');

    const filename = req.file.filename;
    const localFilePath = path.join(__dirname, 'uploads', filename);
    const bucket = storage.bucket('basketball-demo-videos');

    await bucket.upload(localFilePath, { destination: filename });

    const docRef = await db.collection('videos').add({
      filename,
      gcsUri: `gs://basketball-demo-videos/${filename}`,
      status: 'uploaded',
      uploadedAt: new Date().toISOString(),
      project: req.body.project || null,
    });

    res.json({ message: '✅ Video uploaded successfully.', videoId: docRef.id });
  } catch (err) {
    console.error('❌ Upload error:', err);
    res.status(500).send('❌ Upload failed');
  }
});

// === Analyze Video ===
app.get('/analyze-video', async (req, res) => {
  const videoId = req.query.videoId;
  if (!videoId) return res.status(400).send('❌ videoId required');

  try {
    const docRef = db.collection('videos').doc(videoId);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).send('❌ Video not found');

    const { gcsUri } = doc.data();
    const [operation] = await videoClient.annotateVideo({
      inputUri: gcsUri,
      features: ['LABEL_DETECTION', 'SHOT_CHANGE_DETECTION', 'TEXT_DETECTION', 'OBJECT_TRACKING'],
    });

    console.log('🕒 Analyzing...');
    const [result] = await operation.promise({ timeout: 600000 });
    const annotations = result.annotationResults[0];

    await docRef.update({
      analysis: annotations,
      status: 'analyzed',
      analyzedAt: new Date().toISOString(),
    });

    res.send('✅ Video analysis complete.');
  } catch (err) {
    console.error('❌ Analysis error:', err);
    res.status(500).send('❌ Analysis failed: ' + err.message);
  }
});

// === Chat Endpoint ===
app.get('/chat', async (req, res) => {
  const videoId = req.query.videoId;
  if (!videoId) return res.status(400).send('❌ videoId required');

  try {
    const doc = await db.collection('videos').doc(videoId).get();
    if (!doc.exists) return res.status(404).send('❌ Video not found');

    const metadata = doc.data().analysis;
    const labels = metadata.segmentLabelAnnotations?.slice(0, 5)
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

// === Get All Videos ===
app.get('/videos', async (req, res) => {
  try {
    const snapshot = await db.collection('videos').get();
    const videos = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(videos);
  } catch (err) {
    console.error('❌ Failed to fetch videos:', err.message);
    res.status(500).send('❌ Failed to fetch videos');
  }
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
