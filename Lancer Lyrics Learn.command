#!/bin/bash
# Double-cliquez sur ce fichier : met à jour l'app, arrête l'ancien serveur, la lance et ouvre le navigateur.
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-3000}"

echo "→ Mise à jour…"
git pull --ff-only 2>&1 | tail -1

OLD="$(lsof -ti :"$PORT" 2>/dev/null)"
if [ -n "$OLD" ]; then echo "→ Arrêt de l'ancien serveur…"; kill $OLD 2>/dev/null; sleep 1; fi

( sleep 1.5; open "http://localhost:$PORT" 2>/dev/null ) &
echo "→ Lyrics Learn : http://localhost:$PORT   (fermez cette fenêtre pour arrêter)"
PORT="$PORT" exec node server.js
