const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema(
  {
    consumer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    farmer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true
    },
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required: true
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5
    },
    comment: {
      type: String,
      default: ''
    }
  },
  { timestamps: true }
);

// One review per order per product
reviewSchema.index({ consumer: 1, product: 1, order: 1 }, { unique: true });

// Auto-update product and farmer rating after save
reviewSchema.post('save', async function () {
  const Product = mongoose.model('Product');
  const User = mongoose.model('User');

  // Update product rating
  const productReviews = await mongoose.model('Review').find({
    product: this.product
  });
  const productAvg =
    productReviews.reduce((sum, r) => sum + r.rating, 0) /
    productReviews.length;
  await Product.findByIdAndUpdate(this.product, {
    'rating.average': Math.round(productAvg * 10) / 10,
    'rating.count': productReviews.length
  });

  // Update farmer rating
  const farmerReviews = await mongoose.model('Review').find({
    farmer: this.farmer
  });
  const farmerAvg =
    farmerReviews.reduce((sum, r) => sum + r.rating, 0) /
    farmerReviews.length;
  await User.findByIdAndUpdate(this.farmer, {
    'rating.average': Math.round(farmerAvg * 10) / 10,
    'rating.count': farmerReviews.length
  });
});

module.exports = mongoose.model('Review', reviewSchema);