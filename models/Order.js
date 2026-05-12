const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  farmer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  name: String,
  pricePerUnit: Number,
  unit: String,
  quantity: Number,
  totalPrice: Number,
  image: String
});

const orderSchema = new mongoose.Schema(
  {
    consumer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    items: [orderItemSchema],

    // Delivery address
    deliveryAddress: {
      address: { type: String, required: true },
      city: { type: String, required: true },
      state: { type: String, required: true },
      pincode: { type: String, required: true },
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
      }
    },

    // Pricing breakdown
    subtotal: { type: Number, required: true },
    deliveryCharge: { type: Number, default: 0 },
    totalAmount: { type: Number, required: true },

    // Payment
    paymentMethod: {
      type: String,
      enum: ['cod', 'online'],
      default: 'cod'
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending'
    },

    // Order status
    status: {
      type: String,
      enum: [
        'placed',        // Consumer placed order
        'confirmed',     // Farmer confirmed
        'packed',        // Farmer packed it
        'assigned',      // Assigned to delivery person
        'out_for_delivery',
        'delivered',
        'cancelled'
      ],
      default: 'placed'
    },

    // Delivery person assigned
    deliveryPerson: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },

    // Cluster ID - orders grouped together for batch delivery
    clusterId: {
      type: String,
      default: null
    },

    // Estimated delivery date
    estimatedDelivery: {
      type: Date
    },

    // Actual delivery date
    deliveredAt: {
      type: Date
    },

    // Cancellation
    cancelledAt: { type: Date },
    cancellationReason: { type: String },

    // Farmer-specific: which farmer handles this
    // (single farmer per order for simplicity; multi-farmer = multiple orders)
    farmer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    // Notes
    consumerNote: { type: String, default: '' },

    // Status timeline
    statusHistory: [
      {
        status: String,
        timestamp: { type: Date, default: Date.now },
        note: String
      }
    ]
  },
  {
    timestamps: true
  }
);

// Geospatial index on delivery location for clustering
orderSchema.index({ 'deliveryAddress.location': '2dsphere' });
orderSchema.index({ status: 1, farmer: 1 });
orderSchema.index({ clusterId: 1 });

module.exports = mongoose.model('Order', orderSchema);