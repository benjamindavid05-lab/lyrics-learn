# Lyrics Learn

Apprendre une langue avec des paroles Genius : traduction ligne par ligne, objectif de mots par chanson, bibliothèque de mots avec la phrase source au survol.

```bash
npm start     # http://localhost:3000 (PORT=xxxx pour changer)
npm test      # test de l'extracteur Genius
```

Sans dépendance (Node ≥ 18). Les données (chansons, objectifs, bibliothèque) sont stockées dans le navigateur (`localStorage`).
Si Genius refuse la requête (anti-bot), utiliser « Ou coller les paroles ».
La traduction passe par l'endpoint public de Google Translate (sans clé).
