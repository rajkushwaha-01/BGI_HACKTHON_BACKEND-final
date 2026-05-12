const mongoose = require('mongoose');

// This model stores historical prices for each crop/product
// This is what feeds our custom AI price prediction model
// More data = better predictions over time

const priceHistorySchema = new mongoose.Schema(
  {
    // Which farmer's product
    farmer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    // Product reference (optional - for product-specific history)
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product'
    },

    // Crop name (stored separately so history persists even if product deleted)
    cropName: {
      type: String,
      required: true,
      trim: true,
      lowercase: true
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
      ]
    },

    // The actual price set by farmer
    pricePerUnit: {
      type: Number,
      required: true
    },

    unit: {
      type: String,
      enum: ['kg', 'gram', 'dozen', 'piece', 'litre', 'quintal'],
      default: 'kg'
    },

    // Quantity sold at this price (helps weigh demand)
    quantitySold: {
      type: Number,
      default: 0
    },

    // Total revenue at this price
    revenue: {
      type: Number,
      default: 0
    },

    // Number of orders received at this price
    ordersCount: {
      type: Number,
      default: 0
    },

    // Season when this price was recorded
    season: {
      type: String,
      enum: ['summer', 'monsoon', 'winter', 'spring'],
      default: 'summer'
    },

    // Month (1-12) for monthly trend analysis
    month: {
      type: Number,
      min: 1,
      max: 12
    },

    // Year
    year: {
      type: Number
    },

    // Market average price at the time (if available, for comparison)
    marketAveragePrice: {
      type: Number,
      default: 0
    },

    // Was this price manually set or AI suggested?
    source: {
      type: String,
      enum: ['manual', 'ai_suggested', 'ai_accepted'],
      default: 'manual'
    }
  },
  {
    timestamps: true
  }
);

// Index for fast queries by crop and farmer
priceHistorySchema.index({ cropName: 1, farmer: 1 });
priceHistorySchema.index({ cropName: 1, month: 1, year: 1 });
priceHistorySchema.index({ category: 1, month: 1 });

// Static method to get season from month
priceHistorySchema.statics.getSeason = function (month) {
  if ([3, 4, 5].includes(month)) return 'spring';
  if ([6, 7, 8, 9].includes(month)) return 'monsoon';
  if ([10, 11, 12].includes(month)) return 'winter';
  return 'summer'; // Jan, Feb
};

// Static method to record a price entry automatically
priceHistorySchema.statics.recordPrice = async function (data) {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  const season = this.getSeason(month);

  return await this.create({
    ...data,
    month,
    year,
    season
  });
};

module.exports = mongoose.model('PriceHistory', priceHistorySchema);