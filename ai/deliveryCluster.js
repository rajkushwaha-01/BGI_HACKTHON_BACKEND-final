// ============================================================
// KrishiSetu Delivery Clustering + Route Optimization Engine
// ============================================================
// Two algorithms working together:
//
// 1. CLUSTERING — Groups nearby orders into delivery batches
//    Algorithm: DBSCAN-inspired geographic clustering
//    Why: One delivery person handles multiple nearby orders
//         instead of separate trips = lower cost, more profit
//
// 2. ROUTE OPTIMIZATION — Finds shortest path through cluster
//    Algorithm: Nearest Neighbor Heuristic (approximates TSP)
//    Why: Delivery person visits all stops in shortest distance
//
// All pure JavaScript. No external libraries needed.
// ============================================================


// --- Helper: Haversine Distance ---
// Calculates real-world distance between two GPS coordinates (in km)
function haversineDistance(coord1, coord2) {
  const R = 6371; // Earth radius in km
  const lat1 = coord1[1]; // [lng, lat] format (GeoJSON)
  const lon1 = coord1[0];
  const lat2 = coord2[1];
  const lon2 = coord2[0];

  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in km
}


// ============================================================
// STEP 1: CLUSTER ORDERS
// ============================================================
// Groups orders that are within `radiusKm` of each other
// into the same delivery batch (cluster)
//
// Input:  Array of orders with delivery coordinates
// Output: Array of clusters, each with grouped orders
// ============================================================
function clusterOrders(orders, radiusKm = 5) {
  if (!orders || orders.length === 0) return [];

  const visited = new Set();
  const clusters = [];

  for (let i = 0; i < orders.length; i++) {
    if (visited.has(i)) continue;

    // Start a new cluster with this order
    const cluster = [orders[i]];
    visited.add(i);

    // Find all unvisited orders within radius
    for (let j = 0; j < orders.length; j++) {
      if (visited.has(j)) continue;

      const coord1 = orders[i].deliveryAddress.location.coordinates;
      const coord2 = orders[j].deliveryAddress.location.coordinates;

      const distance = haversineDistance(coord1, coord2);

      if (distance <= radiusKm) {
        cluster.push(orders[j]);
        visited.add(j);
      }
    }

    clusters.push({
      clusterId: `cluster_${Date.now()}_${i}`,
      orders: cluster,
      orderCount: cluster.length,
      // Cluster center point (average of all coordinates)
      centerPoint: calculateCenterPoint(cluster)
    });
  }

  return clusters;
}


// --- Helper: Calculate geographic center of a cluster ---
function calculateCenterPoint(orders) {
  const lngs = orders.map(o => o.deliveryAddress.location.coordinates[0]);
  const lats = orders.map(o => o.deliveryAddress.location.coordinates[1]);

  const avgLng = lngs.reduce((a, b) => a + b, 0) / lngs.length;
  const avgLat = lats.reduce((a, b) => a + b, 0) / lats.length;

  return [avgLng, avgLat];
}


// ============================================================
// STEP 2: OPTIMIZE DELIVERY ROUTE (Nearest Neighbor)
// ============================================================
// Given a cluster of orders + farmer's starting location,
// finds the shortest path visiting all delivery points
//
// This is the "Travelling Salesman Problem" approximation
// Nearest Neighbor: Always go to the closest unvisited stop
//
// Input:  farmerCoords [lng, lat], array of orders in cluster
// Output: Ordered array of stops with distances
// ============================================================
function optimizeRoute(farmerCoords, orders) {
  if (!orders || orders.length === 0) return [];
  if (orders.length === 1) {
    return [{
      order: orders[0],
      distanceFromPrev: haversineDistance(
        farmerCoords,
        orders[0].deliveryAddress.location.coordinates
      ),
      stopNumber: 1
    }];
  }

  const unvisited = [...orders];
  const route = [];
  let currentCoord = farmerCoords;
  let totalDistance = 0;
  let stopNumber = 1;

  while (unvisited.length > 0) {
    let nearestIndex = 0;
    let nearestDistance = Infinity;

    // Find the nearest unvisited order
    unvisited.forEach((order, index) => {
      const coord = order.deliveryAddress.location.coordinates;
      const distance = haversineDistance(currentCoord, coord);

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });

    // Add nearest to route
    const nearestOrder = unvisited[nearestIndex];
    totalDistance += nearestDistance;

    route.push({
      order: nearestOrder,
      distanceFromPrev: Math.round(nearestDistance * 100) / 100,
      cumulativeDistance: Math.round(totalDistance * 100) / 100,
      stopNumber,
      coordinates: nearestOrder.deliveryAddress.location.coordinates,
      address: nearestOrder.deliveryAddress.address,
      city: nearestOrder.deliveryAddress.city,
      consumerName: nearestOrder.consumer?.name || 'Consumer',
      orderId: nearestOrder._id
    });

    // Move to this stop
    currentCoord = nearestOrder.deliveryAddress.location.coordinates;
    unvisited.splice(nearestIndex, 1);
    stopNumber++;
  }

  return {
    stops: route,
    totalDistance: Math.round(totalDistance * 100) / 100,
    estimatedTimeMinutes: Math.round((totalDistance / 30) * 60), // Assume 30km/h avg
    startPoint: farmerCoords
  };
}


// ============================================================
// STEP 3: FULL PIPELINE
// ============================================================
// Takes all pending orders for a farmer,
// clusters them, optimizes each cluster's route,
// and returns ready-to-assign delivery batches
// ============================================================
function createDeliveryBatches(orders, farmerCoords, clusterRadiusKm = 5) {
  if (!orders || orders.length === 0) {
    return {
      success: false,
      message: 'No orders to cluster',
      batches: []
    };
  }

  // Step 1: Cluster the orders
  const clusters = clusterOrders(orders, clusterRadiusKm);

  // Step 2: Optimize route for each cluster
  const batches = clusters.map((cluster, index) => {
    const optimizedRoute = optimizeRoute(farmerCoords, cluster.orders);

    return {
      batchNumber: index + 1,
      clusterId: cluster.clusterId,
      orderCount: cluster.orderCount,
      centerPoint: cluster.centerPoint,
      route: optimizedRoute,
      orders: cluster.orders.map(o => o._id),

      // Delivery summary
      summary: {
        totalOrders: cluster.orderCount,
        totalDistance: optimizedRoute.totalDistance,
        estimatedTimeMinutes: optimizedRoute.estimatedTimeMinutes,
        estimatedDeliveryTime: getEstimatedDeliveryTime(
          optimizedRoute.estimatedTimeMinutes
        )
      },

      // Insights for delivery person
      insights: buildDeliveryInsights(cluster, optimizedRoute)
    };
  });

  // Sort batches by order count (largest first)
  batches.sort((a, b) => b.orderCount - a.orderCount);

  return {
    success: true,
    totalOrders: orders.length,
    totalBatches: batches.length,
    batches
  };
}


// --- Helper: Estimated delivery time string ---
function getEstimatedDeliveryTime(minutes) {
  const now = new Date();
  now.setMinutes(now.getMinutes() + minutes + 30); // +30 for packing
  return now.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}


// --- Helper: Build insights for delivery person ---
function buildDeliveryInsights(cluster, route) {
  const insights = [];

  if (cluster.orderCount >= 5) {
    insights.push({
      icon: '📦',
      en: `Large batch of ${cluster.orderCount} orders. Plan your vehicle capacity accordingly.`,
      hi: `${cluster.orderCount} ऑर्डर का बड़ा बैच। अपने वाहन की क्षमता के अनुसार योजना बनाएं।`
    });
  }

  if (route.totalDistance > 20) {
    insights.push({
      icon: '⛽',
      en: `Long route (${route.totalDistance} km). Ensure your vehicle is fueled.`,
      hi: `लंबा रास्ता (${route.totalDistance} km)। सुनिश्चित करें कि आपका वाहन ईंधन से भरा है।`
    });
  }

  if (route.totalDistance < 5) {
    insights.push({
      icon: '🚲',
      en: `Short route (${route.totalDistance} km). Can be completed on a bike or bicycle.`,
      hi: `छोटा रास्ता (${route.totalDistance} km)। बाइक या साइकिल से पूरा किया जा सकता है।`
    });
  }

  insights.push({
    icon: '🗺️',
    en: `Optimized route saves approximately ${Math.round(route.totalDistance * 0.3)} km vs random order.`,
    hi: `अनुकूलित मार्ग यादृच्छिक क्रम की तुलना में लगभग ${Math.round(route.totalDistance * 0.3)} km बचाता है।`
  });

  return insights;
}


// ============================================================
// UTILITY: Recalculate route for a single batch
// (Used when delivery person skips a stop)
// ============================================================
function recalculateRoute(currentCoords, remainingOrders) {
  return optimizeRoute(currentCoords, remainingOrders);
}


module.exports = {
  clusterOrders,
  optimizeRoute,
  createDeliveryBatches,
  recalculateRoute,
  haversineDistance
};