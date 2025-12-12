# Build stage
FROM node:20-slim AS builder

# Install build tools for native dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./
COPY tsconfig.json ./

# Install dependencies including devDependencies
RUN npm ci

# Copy source code
COPY . .

# Build the project
# This handles both frontend (Vite) and backend (TSC) builds via the "build" script
RUN npm run build

# Production stage
FROM node:20-slim

WORKDIR /app

# Copy built artifacts and necessary files from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-node ./dist-node
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/node_modules ./node_modules

# Expose the port the app runs on
EXPOSE 3000

# Start the application using experimental specifier resolution for ESM support
CMD ["node", "--experimental-specifier-resolution=node", "dist-node/server/server.js"]