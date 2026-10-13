# steam-backloggd-sync

Inscrit automatiquement ton temps de jeu Steam comme sessions de jeu sur Backloggd.

Une fonction Netlify planifiée (`netlify/functions/sync.mjs`) s'exécute aux 5 minutes :

1. Elle lit le temps de jeu total de chaque jeu via l'API Web Steam (`GetOwnedGames`).
2. Elle compare avec la lecture précédente, gardée dans Netlify Blobs, et additionne la différence au total du jour pour chaque jeu.
3. Elle écrit ce total dans une session datée du jour, avec la note `Steam`, sur la dernière partie (playthrough) du jeu dans Backloggd. Si le jeu n'a pas encore de partie, il est ajouté à « Playing » et une partie est créée.

Le premier passage ne fait que mémoriser le point de départ : rien de ton historique n'est importé.

### Jeux non-Steam (Steam ROM Manager, émulateurs)

Steam ne garde pas de temps de jeu consultable pour les raccourcis non-Steam. La fonction regarde donc aussi ton statut « En jeu » (`GetPlayerSummaries`) à chaque passage. Si un raccourci tourne, elle compte le temps écoulé depuis le passage précédent (10 minutes au plus), sous le nom du raccourci. La précision est d'environ 5 minutes par session.

- Les étiquettes de région ou de version sont retirées du nom avant la recherche sur Backloggd : `Chrono Trigger (USA)` devient `Chrono Trigger`.
- Ton statut Steam doit être visible : en mode Invisible ou Hors ligne, Steam n'indique pas le jeu en cours.
- Ces jeux apparaissent dans `unmapped` sous une clé comme `ns:Chrono Trigger`, à utiliser comme `appid` dans l'action `map`.

> Backloggd n'a pas d'API publique. Ce projet utilise les mêmes endpoints que le site lui-même, tels que documentés par [backloggd-mcp](https://github.com/DenisionSoft/backloggd-mcp). Ils peuvent changer sans préavis.

## Mise en place

1. Sur Steam, mets les « Détails des jeux » de ton profil en public, puis crée une clé sur <https://steamcommunity.com/dev/apikey>.
2. Trouve ton SteamID64 (17 chiffres), par exemple sur <https://steamid.io>.
3. Crée le site sur Netlify à partir de ce repo, puis ajoute les variables d'environnement suivantes :

| Variable | Rôle |
| --- | --- |
| `STEAM_API_KEY` | Clé de l'API Web Steam |
| `STEAM_ID` | SteamID64 |
| `SYNC_TOKEN` | Un long mot de passe aléatoire qui protège `/api/control` |
| `BACKLOGGD_SESSION` | Valeur du cookie `_backloggd_session` (outils de développement du navigateur, onglet Application/Stockage) |
| `BACKLOGGD_USERNAME`, `BACKLOGGD_PASSWORD` | Optionnel : permet de se reconnecter seul quand le cookie expire |
| `SYNC_TIMEZONE` | Optionnel, `America/Toronto` par défaut |

## Contrôle

Toutes les requêtes ont besoin de `Authorization: Bearer $SYNC_TOKEN`.

```sh
# État : dernier passage, erreurs, jours en attente, jeux non reconnus
curl -H "Authorization: Bearer $SYNC_TOKEN" https://<site>.netlify.app/api/control

# Lancer une synchro tout de suite
curl -X POST -H "Authorization: Bearer $SYNC_TOKEN" -d '{"action":"run"}' https://<site>.netlify.app/api/control

# Associer un jeu Steam (appid) à un jeu Backloggd (slug de l'URL), ou l'ignorer
curl -X POST -H "Authorization: Bearer $SYNC_TOKEN" -d '{"action":"map","appid":1145360,"slug":"hades"}' https://<site>.netlify.app/api/control
curl -X POST -H "Authorization: Bearer $SYNC_TOKEN" -d '{"action":"map","appid":431960,"skip":true}' https://<site>.netlify.app/api/control
curl -X POST -H "Authorization: Bearer $SYNC_TOKEN" -d '{"action":"map","appid":"ns:Chrono Trigger","slug":"chrono-trigger"}' https://<site>.netlify.app/api/control

# Remplacer le cookie Backloggd sans redéployer
curl -X POST -H "Authorization: Bearer $SYNC_TOKEN" -d '{"action":"cookie","value":"..."}' https://<site>.netlify.app/api/control
```

Quand un titre Steam correspond à plusieurs jeux sur Backloggd (ou à aucun), rien n'est deviné. Le jeu apparaît sous `unmapped` avec des candidats, et ses minutes restent en attente jusqu'à ce que tu l'associes.

## Développement

```sh
npm install
npm test
```
