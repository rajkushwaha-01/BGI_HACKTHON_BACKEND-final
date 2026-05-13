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
    role: {
      type: String,
      enum: ['farmer', 'consumer', 'admin','delivery'],
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

    // Delivery radius in kilometers (farmer sets this)
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

    isActive: {
      type: Boolean,
      default: true
    },
    isApproved: {
  type: Boolean,
  default: false  // farmers start as unapproved
},
    // Rating (for farmers)
    rating: {
      average: { type: Number, default: 0 },
      count: { type: Number, default: 0 }
    }
  },
  {
    timestamps: true
  }
);

// Create geospatial index for location-based queries
userSchema.index({ location: '2dsphere' });

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Method to compare passwords
userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);