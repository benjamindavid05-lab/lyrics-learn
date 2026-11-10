# Lyrics Learn

Apprendre une langue avec des paroles Genius : traduction ligne par ligne, objectif de mots par chanson, bibliothèque de mots avec la phrase source au survol.

```bash
npm start     # http://localhost:3000 (PORT=xxxx pour changer)
npm test      # test de l'extracteur Genius
```

Sans dépendance (Node ≥ 18). Les données (chansons, objectifs, bibliothèque) sont stockées dans le navigateur (`localStorage`).
Si Genius refuse la requête (anti-bot), utiliser « Ou coller les paroles ».
La traduction passe par l'endpoint public de Google Translate (sans clé).

## Recherche Genius (optionnelle)

1. Créez un client sur https://genius.com/api-clients (gratuit), puis « Generate Access Token ».
2. Créez un fichier `.env` à la racine : `GENIUS_TOKEN=votre_jeton`
3. Relancez `npm start`.

Sans jeton, on peut coller directement un lien Genius dans la barre de recherche.
Les paroles viennent de la page Genius ouverte par l'utilisateur (copier avec ⌘A / ⌘C), jamais d'un accès automatisé du serveur.

## Traduction avec Gemini (gratuit, recommandé)

1. Créez une clé sur https://aistudio.google.com/apikey (gratuit).
2. Ajoutez dans `.env` : `GEMINI_API_KEY=votre_cle` (modèle optionnel : `GEMINI_MODEL=...`).
3. Relancez `npm start`. L'en-tête affiche « ✨ Traduction : Gemini ».

La chanson est traduite d'un coup avec son contexte ; les mots le sont avec leur phrase d'origine.
Sans clé, ou si le quota est atteint, l'app retombe sur Google Translate (vers par vers).
Voir `.env.example`.
