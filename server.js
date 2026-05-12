const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const dns = require('dns');

// Fix MongoDB Atlas DNS issues
dns.setServers(['1.1.1.1', '8.8.8.8']);
dns.setDefaultResultOrder('ipv4first');

dotenv.config();

const requiredEnv = [
  'MONGO_URI',
  'JWT_SECRET',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET'
];
const missingEnv = requiredEnv.filter((name) => !process.env[name]);
if (missingEnv.length > 0) {
  console.error('❌ Missing required environment variables:', missingEnv.join(', '));
  process.exit(1);
}

const app = express();

// Trust proxy (important for deployment/cookies)
app.set('trust proxy', 1);

const allowedOrigins = ['http://localhost:5173'];
if (process.env.CLIENT_URL) {
  allowedOrigins.push(process.env.CLIENT_URL);
}

// Middleware
app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files for uploaded images
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/products', require('./routes/products'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/delivery', require('./routes/delivery'));

// Health check
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'KrishiSetu API is running 🌾'
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.stack);

  res.status(500).json({
    success: false,
    message: 'Something went wrong!',
    error: err.message
  });
});

// Port
const PORT = process.env.PORT || 5000;

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('✅ MongoDB connected');

    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('❌ MongoDB connection error:');
    console.error(err);
    process.exit(1);
  });