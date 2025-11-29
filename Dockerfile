# --- Stage 1: Builder ---
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first to leverage Docker cache
COPY package.json package-lock.json ./

# Install ALL dependencies (including devDependencies like typescript)
RUN npm ci

# Copy the rest of the source code
COPY . .

# CRITICAL FIX: Ensure wallets.txt exists before build/copy
# This prevents the build from crashing if theres no file locally yet.
RUN touch wallets.txt

# Run the build script (compiles TS to dist-node and Vite to dist)
RUN npm run build

# --- Stage 2: Production Runner ---
FROM node:20-alpine AS runner

WORKDIR /app

# Set production environment
ENV NODE_ENV=production
ENV PORT=3000

# Copy package files again
COPY package.json package-lock.json ./

# Install ONLY production dependencies to keep image small
RUN npm ci --only=production

# Copy compiled backend from builder
COPY --from=builder /app/dist-node ./dist-node

# Copy compiled frontend from builder (for static serving)
COPY --from=builder /app/dist ./dist

# Copy wallets.txt to the runner's working directory
COPY --from=builder /app/wallets.txt ./

# Create a non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# Expose the application port
EXPOSE 3000

# Start the server directly from the compiled JS file
CMD ["node", "dist-node/server/server.js"]