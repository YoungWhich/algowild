@echo off
set PORT=17000
set JWT_SECRET=c2c47362bdf48e3ebd0d4f346b07443bcf2a8bba9d1cfd64c46d0d3960a833f7
set MASTER_USERNAME=admin
set MASTER_PASSWORD=k7pXg5LM5bGZFyoN
echo Starting algowild server on port %PORT% ...
echo Local play: open http://127.0.0.1:%PORT%/ in your browser.
echo Keep THIS window open while playing. Close it to stop the server.
npm start
pause
