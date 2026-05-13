const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true
    },
    phone: {
      type: String,
      required: [true, 'Phone number is required'],
      trim: true
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: 6
    },

    // ✅ FIXED: delivery added to enum
    role: {
      type: String,
      enum: ['farmer', 'consumer', 'admin', 'delivery'],
      default: 'consumer'
    },

    // Location (GeoJSON Point for geospatial queries)
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point'
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        default: [0, 0]
      },
      address: {
        type: String,
        default: ''
      },
      city: {
        type: String,
        default: ''
      },
      state: {
        type: String,
        default: ''
      }
    },

    // Farmer-specific fields
    farmName: {
      type: String,
      default: ''
    },
    farmSizeAcres: {
      type: Number,
      default: 0
    },

    // Delivery radius in km (farmer sets this)
    deliveryRadiusKm: {
      type: Number,
      default: 20,
      min: 1,
      max: 200
    },

    // Preferred language
    language: {
      type: String,
      enum: ['en', 'hi'],
      default: 'en'
    },

    // Profile picture
    avatar: {
      type: String,
      default: ''
    },

    // Admin can deactivate any account
    isActive: {
      type: Boolean,
      default: true
    },

    // Farmers need admin approval before listing products
    isApproved: {
      type: Boolean,
      default: false
    },

    // Rating (for farmers)
    rating: {
      average: { type: Number, default: 0 },
      count: { type: Number, default: 0 }
    },

    // ── Notifications array ──────────────────────────
    // Stores in-app notifications for the user
    notifications: [
      {
        title: { type: String },
        message: { type: String },
        type: {
          type: String,
          enum: [
            'order_placed',
            'order_confirmed',
            'order_packed',
            'order_assigned',
            'order_delivered',
            'order_cancelled',
            'account_approved',
            'account_deactivated',
            'low_stock',
            'out_of_stock',
            'price_suggestion',
            'general'
          ],
          default: 'general'
        },
        isRead: { type: Boolean, default: false },
        link: { type: String, default: '' },
        createdAt: { type: Date, default: Date.now }
      }
    ]
  },
  {
    timestamps: true
  }
);

// Geospatial index
userSchema.index({ location: '2dsphere' });

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Compare password
userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// ── Helper: push a notification to this user ──────────────
userSchema.methods.pushNotification = async function ({
  title,
  message,
  type = 'general',
  link = ''
}) {
  this.notifications.unshift({ title, message, type, link });

  // Keep only last 50 notifications
  if (this.notifications.length > 50) {
    this.notifications = this.notifications.slice(0, 50);
  }

  await this.save();
};

module.exports = mongoose.model('User', userSchema);