const PriceHistory = require('../models/PriceHistory');

// ============================================================
// KrishiSetu Custom AI Price Prediction Engine
// ============================================================
// This is NOT a generic chatbot. This is a purpose-built ML
// engine that uses the following techniques:
//
// 1. Weighted Moving Average (recent prices matter more)
// 2. Seasonal Adjustment (monsoon vs winter pricing patterns)
// 3. Demand Elasticity (how quantity sold changes with price)
// 4. Linear Regression (trend direction over time)
// 5. Confidence Scoring (how reliable is the prediction)
//
// All computed in-house using simple statistics.
// No external AI API needed.
// ============================================================

// --- Helper: Simple Linear Regression ---
// Given arrays of x and y values, returns slope and intercept
function linearRegression(x, y) {
  const n = x.length;
  if (n < 2) return { slope: 0, intercept: y[0] || 0, r2: 0 };

  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((acc, xi, i) => acc + xi * y[i], 0);
  const sumX2 = x.reduce((acc, xi) => acc + xi * xi, 0);

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  // R-squared (goodness of fit — 1.0 = perfect)
  const yMean = sumY / n;
  const ssTot = y.reduce((acc, yi) => acc + Math.pow(yi - yMean, 2), 0);
  const ssRes = y.reduce((acc, yi, i) => {
    const predicted = slope * x[i] + intercept;
    return acc + Math.pow(yi - predicted, 2);
  }, 0);
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;

  return { slope, intercept, r2: Math.max(0, r2) };
}

// --- Helper: Weighted Moving Average ---
// More recent entries get higher weight
function weightedMovingAverage(prices) {
  if (!prices.length) return 0;
  const n = prices.length;
  let weightedSum = 0;
  let totalWeight = 0;

  prices.forEach((price, i) => {
    const weight = i + 1; // index 0 = weight 1, last = weight n
    weightedSum += price * weight;
    totalWeight += weight;
  });

  return weightedSum / totalWeight;
}

// --- Helper: Seasonal multiplier ---
// Prices fluctuate by season — this adjusts prediction accordingly
function getSeasonalMultiplier(cropName, targetMonth) {
  const month = targetMonth || new Date().getMonth() + 1;

  // General seasonal patterns for Indian agriculture
  const seasonalPatterns = {
    tomato:     [1.3, 1.2, 1.0, 0.9, 0.8, 1.1, 1.3, 1.4, 1.2, 1.0, 0.9, 1.1],
    onion:      [1.1, 1.0, 0.9, 1.0, 1.2, 1.4, 1.5, 1.3, 1.1, 0.9, 0.8, 1.0],
    potato:     [1.0, 1.0, 0.9, 0.9, 1.0, 1.1, 1.2, 1.2, 1.1, 1.0, 0.9, 1.0],
    wheat:      [1.0, 1.0, 0.9, 0.8, 1.0, 1.1, 1.1, 1.1, 1.0, 1.0, 1.0, 1.0],
    rice:       [1.1, 1.1, 1.0, 1.0, 1.0, 1.0, 0.9, 0.9, 0.8, 0.9, 1.0, 1.1],
    mango:      [1.0, 1.0, 1.1, 1.3, 1.5, 1.4, 1.2, 1.0, 0.9, 0.9, 1.0, 1.0],
    default:    [1.0, 1.0, 1.0, 1.0, 1.0, 1.1, 1.1, 1.1, 1.0, 1.0, 1.0, 1.0]
  };

  const crop = cropName.toLowerCase();
  const pattern = seasonalPatterns[crop] || seasonalPatterns['default'];
  return pattern[month - 1];
}

// --- Helper: Demand Elasticity Score ---
// If farmer sold more at a higher price = demand is inelastic = can raise price
// If farmer sold less at higher price = demand is elastic = lower price to sell more
function analyzeDemandElasticity(history) {
  if (history.length < 3) return { elasticity: 0, recommendation: 'neutral' };

  // Sort by price
  const sorted = [...history].sort((a, b) => a.pricePerUnit - b.pricePerUnit);

  // Find correlation between price and quantity sold
  const prices = sorted.map(h => h.pricePerUnit);
  const quantities = sorted.map(h => h.quantitySold || 1);

  const { slope } = linearRegression(prices, quantities);

  // Negative slope = demand falls as price rises (elastic)
  // Positive slope = demand rises with price (unusual, maybe quality signal)
  const elasticity = slope;

  let recommendation;
  if (elasticity < -0.5) recommendation = 'lower'; // Very elastic
  else if (elasticity < 0) recommendation = 'neutral';
  else recommendation = 'raise'; // Inelastic or positive

  return { elasticity, recommendation };
}

// --- Helper: Confidence Score ---
function calculateConfidence(dataPoints, r2, priceVariance) {
  let score = 0;

  // More data = more confidence
  if (dataPoints >= 20) score += 40;
  else if (dataPoints >= 10) score += 30;
  else if (dataPoints >= 5) score += 20;
  else score += 10;

  // Better regression fit = more confidence
  score += Math.round(r2 * 30);

  // Lower variance = more confidence
  if (priceVariance < 10) score += 30;
  else if (priceVariance < 25) score += 20;
  else if (priceVariance < 50) score += 10;

  return Math.min(score, 100);
}

// ============================================================
// MAIN PREDICTION FUNCTION
// ============================================================
async function predictPrice(farmerId, cropName, unit = 'kg') {
  try {
    // Fetch all historical price data for this crop
    // Either by this specific farmer or platform-wide (for new farmers)
    let history = await PriceHistory.find({
      cropName: cropName.toLowerCase()
    })
      .sort({ createdAt: 1 })
      .lean();

    const farmerHistory = history.filter(
      h => h.farmer.toString() === farmerId.toString()
    );

    // Use farmer's own history if enough data, else use platform-wide
    const useHistory = farmerHistory.length >= 3 ? farmerHistory : history;

    if (useHistory.length === 0) {
      return {
        success: false,
        message: 'Not enough historical data for this crop yet.',
        suggestedPrice: null,
        insights: []
      };
    }

    const prices = useHistory.map(h => h.pricePerUnit);
    const indices = useHistory.map((_, i) => i);

    // 1. Linear Regression for trend
    const regression = linearRegression(indices, prices);
    const nextIndex = useHistory.length;
    let trendPrice = regression.slope * nextIndex + regression.intercept;

    // 2. Weighted Moving Average
    const wmaPrice = weightedMovingAverage(prices);

    // 3. Seasonal Adjustment
    const currentMonth = new Date().getMonth() + 1;
    const seasonalMultiplier = getSeasonalMultiplier(cropName, currentMonth);

    // 4. Blend trend + WMA (60% WMA, 40% trend)
    let basePrice = 0.6 * wmaPrice + 0.4 * trendPrice;

    // 5. Apply seasonal adjustment
    let predictedPrice = basePrice * seasonalMultiplier;

    // 6. Demand elasticity analysis
    const { recommendation: demandRec } = analyzeDemandElasticity(useHistory);

    // Adjust based on demand
    if (demandRec === 'raise') predictedPrice *= 1.05;
    else if (demandRec === 'lower') predictedPrice *= 0.95;

    // Round to nearest 0.5
    predictedPrice = Math.round(predictedPrice * 2) / 2;

    // 7. Price range (±10%)
    const lowerBound = Math.round(predictedPrice * 0.9 * 2) / 2;
    const upperBound = Math.round(predictedPrice * 1.1 * 2) / 2;

    // 8. Price variance for confidence
    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    const variance =
      prices.reduce((acc, p) => acc + Math.pow(p - avgPrice, 2), 0) /
      prices.length;

    // 9. Confidence score
    const confidence = calculateConfidence(
      useHistory.length,
      regression.r2,
      variance
    );

    // 10. Build human-readable insights
    const insights = buildInsights({
      cropName,
      predictedPrice,
      lowerBound,
      upperBound,
      regression,
      seasonalMultiplier,
      demandRec,
      confidence,
      dataPoints: useHistory.length,
      isPersonalized: farmerHistory.length >= 3,
      currentMonth,
      unit
    });

    return {
      success: true,
      cropName,
      unit,
      suggestedPrice: predictedPrice,
      priceRange: { low: lowerBound, high: upperBound },
      confidence,
      trend: regression.slope > 0.5 ? 'rising' : regression.slope < -0.5 ? 'falling' : 'stable',
      seasonalMultiplier,
      demandSignal: demandRec,
      dataPoints: useHistory.length,
      isPersonalized: farmerHistory.length >= 3,
      insights
    };
  } catch (error) {
    console.error('Price prediction error:', error);
    return {
      success: false,
      message: 'Prediction failed. Please try again.',
      error: error.message
    };
  }
}

// ============================================================
// BUILD INSIGHT MESSAGES (English + Hindi)
// ============================================================
function buildInsights({
  cropName,
  predictedPrice,
  lowerBound,
  upperBound,
  regression,
  seasonalMultiplier,
  demandRec,
  confidence,
  dataPoints,
  isPersonalized,
  currentMonth,
  unit
}) {
  const insights = [];
  const months = [
    '', 'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const monthsHi = [
    '', 'जनवरी', 'फरवरी', 'मार्च', 'अप्रैल', 'मई', 'जून',
    'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर'
  ];

  // Trend insight
  if (regression.slope > 0.5) {
    insights.push({
      type: 'trend',
      icon: '📈',
      en: `${cropName} prices have been rising recently. This is a good time to sell.`,
      hi: `${cropName} के भाव हाल ही में बढ़ रहे हैं। बेचने का यह अच्छा समय है।`
    });
  } else if (regression.slope < -0.5) {
    insights.push({
      type: 'trend',
      icon: '📉',
      en: `${cropName} prices have been falling. Consider selling quickly or storing if possible.`,
      hi: `${cropName} के भाव गिर रहे हैं। जल्दी बेचें या संभव हो तो भंडारण करें।`
    });
  } else {
    insights.push({
      type: 'trend',
      icon: '📊',
      en: `${cropName} prices are stable right now. Safe to list at the suggested price.`,
      hi: `${cropName} के भाव अभी स्थिर हैं। सुझाए गए भाव पर सूचीबद्ध करना सुरक्षित है।`
    });
  }

  // Seasonal insight
  if (seasonalMultiplier > 1.1) {
    insights.push({
      type: 'seasonal',
      icon: '🌤️',
      en: `${months[currentMonth]} is typically a high-demand month for ${cropName}. You can price slightly higher.`,
      hi: `${monthsHi[currentMonth]} में ${cropName} की मांग आमतौर पर अधिक होती है। आप थोड़ा अधिक भाव रख सकते हैं।`
    });
  } else if (seasonalMultiplier < 0.95) {
    insights.push({
      type: 'seasonal',
      icon: '🌧️',
      en: `${months[currentMonth]} tends to have lower demand for ${cropName}. A competitive price will help you sell faster.`,
      hi: `${monthsHi[currentMonth]} में ${cropName} की मांग कम होती है। प्रतिस्पर्धी भाव आपको जल्दी बेचने में मदद करेगा।`
    });
  }

  // Demand insight
  if (demandRec === 'raise') {
    insights.push({
      type: 'demand',
      icon: '💰',
      en: `Your sales data shows buyers are willing to pay more for your ${cropName}. You can raise the price slightly.`,
      hi: `आपके बिक्री डेटा से पता चलता है कि खरीदार आपके ${cropName} के लिए अधिक भुगतान करने को तैयार हैं।`
    });
  } else if (demandRec === 'lower') {
    insights.push({
      type: 'demand',
      icon: '🛒',
      en: `Lowering your price slightly could attract more buyers and increase your total revenue.`,
      hi: `थोड़ा कम भाव अधिक खरीदार आकर्षित कर सकता है और आपकी कुल आय बढ़ा सकता है।`
    });
  }

  // Confidence insight
  if (confidence >= 70) {
    insights.push({
      type: 'confidence',
      icon: '✅',
      en: `High confidence prediction based on ${dataPoints} data points. ${isPersonalized ? 'Personalized to your farm history.' : ''}`,
      hi: `${dataPoints} डेटा बिंदुओं पर आधारित उच्च विश्वास पूर्वानुमान। ${isPersonalized ? 'आपके खेत के इतिहास के अनुसार व्यक्तिगत।' : ''}`
    });
  } else if (confidence < 40) {
    insights.push({
      type: 'confidence',
      icon: '⚠️',
      en: `Low confidence — limited data available. As you list more products, predictions will improve.`,
      hi: `कम विश्वास — सीमित डेटा उपलब्ध है। जैसे-जैसे आप अधिक उत्पाद सूचीबद्ध करेंगे, पूर्वानुमान बेहतर होगा।`
    });
  }

  // Price range insight
  insights.push({
    type: 'range',
    icon: '🎯',
    en: `Suggested price range: ₹${lowerBound} – ₹${upperBound} per ${unit}. Best price: ₹${predictedPrice}.`,
    hi: `सुझाया गया मूल्य सीमा: ₹${lowerBound} – ₹${upperBound} प्रति ${unit}। सर्वोत्तम मूल्य: ₹${predictedPrice}।`
  });

  return insights;
}

// ============================================================
// BATCH ANALYSIS — for farmer dashboard summary
// ============================================================
async function getFarmerPriceSummary(farmerId) {
  try {
    const history = await PriceHistory.find({ farmer: farmerId })
      .sort({ createdAt: -1 })
      .lean();

    if (!history.length) {
      return { success: false, message: 'No price history found.' };
    }

    // Group by crop
    const byCrop = {};
    history.forEach(h => {
      if (!byCrop[h.cropName]) byCrop[h.cropName] = [];
      byCrop[h.cropName].push(h);
    });

    const summary = Object.entries(byCrop).map(([crop, entries]) => {
      const prices = entries.map(e => e.pricePerUnit);
      const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
      const totalRevenue = entries.reduce((a, e) => a + (e.revenue || 0), 0);
      const totalSold = entries.reduce((a, e) => a + (e.quantitySold || 0), 0);
      const lastPrice = entries[0].pricePerUnit;

      return {
        crop,
        avgPrice: Math.round(avgPrice * 100) / 100,
        lastPrice,
        totalRevenue,
        totalSold,
        dataPoints: entries.length
      };
    });

    return { success: true, summary };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

module.exports = { predictPrice, getFarmerPriceSummary, linearRegression };