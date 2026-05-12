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

const app = express();

// Trust proxy (important for deployment/cookies)
app.set('trust proxy', 1);

// Middleware
app.use(cors({
  origin: [
    'http://localhost:5173',
    process.env.CLIENT_URL
  ],
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

    app.listen(process.env.PORT || 5000, () => {
      console.log(`🚀 Server running`);
    });
  })
  .catch((err) => {
    console.error('❌ FULL MONGODB ERROR:');
    console.error(err);
    process.exit(1);
  });