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
app.use(express.json());

// === Firebase Setup ===
const firebaseCreds = JSON.parse(
  Buffer.from(process.env.FIREBASE_KEY_BASE64, 'base64').toString('utf8')
);
admin.initializeApp({ credential: admin.credential.cert(firebaseCreds) });
const db = admin.firestore();

// === Google Cloud Setup ===
if (!process.env.GOOGLE_KEY_BASE64) {
  console.error('❌ GOOGLE_KEY_BASE64 not found');
  process.exit(1);
}

let storage, videoClient;
try {
  const decoded = Buffer.from(process.env.GOOGLE_KEY_BASE64, 'base64').toString('utf8');
  const parsed = JSON.parse(decoded);
  parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  fs.writeFileSync(keyPath, JSON.stringify(parsed, null, 2));
  storage = new Storage({ keyFilename: keyPath });
  videoClient = new VideoIntelligenceServiceClient({ keyFilename: keyPath });
  console.log('✅ Google Cloud clients initialized');
} catch (err) {
  console.error('❌ GOOGLE_KEY_BASE64 decode failed:', err.message);
  process.exit(1);
}

// === OpenAI Setup ===
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// === Multer Setup (up to 5GB)
const upload = multer({ dest: 'uploads/', limits: { fileSize: 5 * 1024 * 1024 * 1024 } });

// === Health Check ===
app.get('/health', (req, res) => res.send('✅ Server is up'));

// === Upload Endpoint ===
app.post('/upload-video', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('❌ No file uploaded');

    const { originalname, filename, size } = req.file;
    const localPath = path.join(__dirname, 'uploads', filename);
    const bucket = storage.bucket('basketball-demo-videos');
    const destination = filename;

    await bucket.upload(localPath, { destination });

    const doc = await db.collection('videos').add({
      name: originalname,
      size,
      filename,
      gcsUri: `gs://basketball-demo-videos/${filename}`,
      status: 'uploaded',
      uploadedAt: new Date().toISOString(),
      project: req.body.project || null,
    });

    res.json({ message: '✅ Uploaded', videoId: doc.id });
  } catch (err) {
    console.error('❌ Upload error:', err);
    res.status(500).send('❌ Upload failed');
  }
});

// === Analyze Endpoint ===
app.get('/analyze-video', async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).send('❌ videoId is required');

  try {
    const docRef = db.collection('videos').doc(videoId);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).send('❌ Video not found');

    const { gcsUri } = doc.data();
    const [operation] = await videoClient.annotateVideo({
      inputUri: gcsUri,
      features: ['LABEL_DETECTION', 'SHOT_CHANGE_DETECTION', 'TEXT_DETECTION', 'OBJECT_TRACKING'],
    });

    const [result] = await operation.promise({ timeout: 600000 });
//     const annotations = result.annotationResults[0];

// const analysisFilename = `analysis_${videoId}.json`;
// const tempPath = path.join(__dirname, analysisFilename);
// fs.writeFileSync(tempPath, JSON.stringify(annotations, null, 2));
const parsed = parseAnalysis(result.annotationResults[0]);
fs.writeFileSync(tempPath, JSON.stringify(parsed, null, 2));
await storage.bucket('basketball-demo-videos').upload(tempPath, {
  destination: `analysis/${analysisFilename}`
});
await docRef.update({
  analysisPath: `analysis/${analysisFilename}`,
  status: 'analyzed',
  analyzedAt: new Date().toISOString(),
});

await storage.bucket('basketball-demo-videos').upload(tempPath, {
  destination: `analysis/${analysisFilename}`
});

fs.unlinkSync(tempPath); // remove temp file

await docRef.update({
  analysisPath: `analysis/${analysisFilename}`,
  status: 'analyzed',
  analyzedAt: new Date().toISOString(),
});
    console.log(`✅ Analysis complete for video ${videoId}`);


    res.send('✅ Analysis complete');
  } catch (err) {
    console.error('❌ Analysis failed:', err);
    res.status(500).send('❌ Analysis failed');
  }
});

// === Chat Endpoint ===
app.get('/chat', async (req, res) => {
  const { videoId, q } = req.query;
  if (!videoId) return res.status(400).send('❌ videoId required');

  try {
    const doc = await db.collection('videos').doc(videoId).get();
    if (!doc.exists) return res.status(404).send('❌ Video not found');

    const analysisPath = doc.data().analysisPath;
const [file] = await storage.bucket('basketball-demo-videos').file(analysisPath).download();
const metadata = JSON.parse(file.toString());

    const labels = metadata.segmentLabelAnnotations
      ?.slice(0, 5)
      .map(l => `${l.entity.description}: ${l.segments.length} segments`)
      .join('\n');

    const prompt = `Video Metadata:\n${labels}\n\nQuestion: ${q || 'Summarize the video'}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a basketball analysis expert.' },
        { role: 'user', content: prompt },
      ],
    });

    res.send(response.choices[0].message.content);
  } catch (err) {
    console.error('❌ Chat error:', err.message);
    res.status(500).send('❌ Chat failed');
  }
});

// === List Videos ===
// === Get All Videos ===
app.get('/videos', async (req, res) => {
  try {
    const includeAnalysis = req.query.includeAnalysis === 'true';
    const snapshot = await db.collection('videos').get();

    const videos = await Promise.all(snapshot.docs.map(async (doc) => {
      const data = doc.data();
      const video = { id: doc.id, ...data };

      if (includeAnalysis && data.analysisPath) {
        try {
          const [file] = await storage.bucket('basketball-demo-videos').file(data.analysisPath).download();
          video.analysis = JSON.parse(file.toString());
        } catch (err) {
          console.warn(`⚠️ Failed to load analysis for video ${doc.id}: ${err.message}`);
        }
      }

      return video;
    }));

    res.json(videos);
  } catch (err) {
    console.error('❌ Failed to fetch videos:', err.message);
    res.status(500).send('❌ Failed to fetch videos');
  }
});


app.listen(port, () => console.log(`🚀 Running on port ${port}`));
