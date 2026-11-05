#!/bin/zsh
export PATH="/Users/rodrigodiaz/.nvm/versions/node/v22.17.1/bin:$PATH"
kill $(lsof -ti tcp:4317) 2>/dev/null
sleep 1
cd /Users/rodrigodiaz/Documents/own/mr-claudio-assisstant
nohup pnpm start > /tmp/session-assistant-electron.log 2>&1 &
