const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    farmer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    name: {
      type: String,
      required: [true, 'Product name is required'],
      trim: true
    },
    nameHindi: {
      type: String,
      default: ''
    },
    category: {
      type: String,
      enum: [
        'vegetables',
        'fruits',
        'grains',
        'pulses',
        'dairy',
        'spices',
        'herbs',
        'other'
      ],
      required: true
    },
    description: {
      type: String,
      default: ''
    },
    descriptionHindi: {
      type: String,
      default: ''
    },

    // Pricing
    pricePerUnit: {
      type: Number,
      required: [true, 'Price is required'],
      min: 0
    },
    unit: {
      type: String,
      enum: ['kg', 'gram', 'dozen', 'piece', 'litre', 'quintal'],
      default: 'kg'
    },

    // Stock
    quantityAvailable: {
      type: Number,
      required: true,
      min: 0
    },
    minimumOrderQuantity: {
      type: Number,
      default: 1
    },

    // Images
    images: [
      {
        type: String
      }
    ],

    // Farmer's delivery location (copied from farmer for geo queries)
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point'
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        default: [0, 0]
      }
    },

    // Delivery radius in km (copied from farmer profile)
    deliveryRadiusKm: {
      type: Number,
      default: 20
    },

    isAvailable: {
      type: Boolean,
      default: true
    },

    // Organic certification
    isOrganic: {
      type: Boolean,
      default: false
    },

    // Harvest date
    harvestDate: {
      type: Date
    },

    // Tags for search
    tags: [String],

    // Rating
    rating: {
      average: { type: Number, default: 0 },
      count: { type: Number, default: 0 }
    }
  },
  {
    timestamps: true
  }
);

// Geospatial index for radius-based queries
productSchema.index({ location: '2dsphere' });
productSchema.index({ name: 'text', tags: 'text' });

module.exports = mongoose.model('Product', productSchema);