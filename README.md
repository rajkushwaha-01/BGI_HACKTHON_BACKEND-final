# KrishiSetu

KrishiSetu is a farmer-to-consumer agriculture marketplace built for the BGI Hackathon. It includes a Node.js/Express backend and a React + Vite frontend, enabling farmers, consumers, delivery personnel, and admins to collaborate on fresh produce sales, order management, and delivery planning.

## Project Structure

- `BGI_HACKTHON_BACKEND/` - Backend API server
- `Frontend-BGI/` - Frontend web application

## Key Features

- User authentication and role-based access
- Farmer registration with admin approval workflow
- Product catalog and category filtering
- Shopping cart, checkout, and order history for consumers
- Farmer dashboard with product management and order tracking
- Delivery routing and cluster-based delivery assignment
- AI-powered pricing and prediction endpoints
- Localization support for English and Hindi
- Cloudinary image uploads
- Built with MongoDB, Express, React, Vite, Tailwind CSS, and Zustand

## Backend

### Location
`BGI_HACKTHON_BACKEND/`

### Available scripts

- `npm install` - install backend dependencies
- `npm run dev` - start backend with `nodemon`
- `npm start` - start backend with Node

### Environment variables
Create a `.env` file in `BGI_HACKTHON_BACKEND/` with:

```env
MONGO_URI=<your-mongodb-connection-string>
JWT_SECRET=<your-jwt-secret>
CLOUDINARY_CLOUD_NAME=<cloudinary-cloud-name>
CLOUDINARY_API_KEY=<cloudinary-api-key>
CLOUDINARY_API_SECRET=<cloudinary-api-secret>
CLIENT_URL=http://localhost:5173
PORT=5000
```

### API Routes

- `GET /` - health check
- `POST /api/auth` - auth routes
- `GET|POST /api/products` - product routes
- `GET|POST /api/orders` - order routes
- `POST /api/ai` - AI pricing/insights routes
- `GET|POST /api/delivery` - delivery cluster/routes routes

## Frontend

### Location
`Frontend-BGI/`

### Available scripts

- `npm install` - install frontend dependencies
- `npm run dev` - start Vite dev server
- `npm run build` - build production assets
- `npm run preview` - preview production build

### Frontend pages and flows

- Home and product browsing
- Consumer cart, checkout, orders, and order details
- Farmer dashboard, add/edit products, farmer order views
- Delivery dashboard and route tracking
- Admin dashboard for managing approvals and platform data
- Authentication pages: login and register

## Getting Started

### 1. Setup backend

```bash
cd BGI_HACKTHON_BACKEND
npm install
```

Create `.env` and configure the required variables.

### 2. Start backend

```bash
npm run dev
```

### 3. Setup frontend

```bash
cd ../Frontend-BGI
npm install
```

### 4. Start frontend

```bash
npm run dev
```

### 5. Open the app

By default, the frontend runs on `http://localhost:5173` and the backend on `http://localhost:5000`.

## Notes

- Make sure the backend is running before using the frontend.
- Set `CLIENT_URL` in backend `.env` if the frontend is hosted on a different origin.
- Cloudinary is used for product image uploads.

## Tech Stack

- Backend: Node.js, Express, MongoDB, Mongoose, JWT, Cloudinary, Multer
- Frontend: React, Vite, Tailwind CSS, Zustand, React Router, Axios

## License

This project is created for hackathon purposes.
