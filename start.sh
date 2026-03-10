#!/bin/bash

# Navigate to the directory where the script is located
cd "$(dirname "$0")"

echo "🛑 Stopping existing services..."
# Kill any running vite or node server.js processes
pkill -f "vite" || true
pkill -f "node server.js" || true

echo "🚀 Starting backend server (server.js)..."
nohup node server.js > server.log 2>&1 &
BACKEND_PID=$!

echo "🚀 Starting frontend dev server (Vite)..."
nohup npm run dev > frontend.log 2>&1 &
FRONTEND_PID=$!

echo "⏳ Waiting for services to start..."
sleep 3

echo "🌐 Opening browser..."
open http://localhost:3000

echo "✅ Services started in background."
echo "   Backend PID: $BACKEND_PID (Logs: tail -f server.log)"
echo "   Frontend PID: $FRONTEND_PID (Logs: tail -f frontend.log)"
echo ""
echo "💡 To stop the services later, you can run: pkill -f vite && pkill -f 'node server.js'"
