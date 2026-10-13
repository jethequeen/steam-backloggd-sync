# steam-backloggd-sync

Inscrit automatiquement ton temps de jeu Steam comme sessions de jeu sur Backloggd.

Une fonction Netlify planifiée (`netlify/functions/sync.mjs`) s'exécute aux 5 minutes :

1. Elle lit le temps de jeu total de chaque jeu via l'API Web Steam (`GetOwnedGames`).
2. Elle compare avec la lecture précédente, gardée dans Netlify Blobs, et additionne la différence au total du jour pour chaque jeu.
3. Elle écrit ce total dans une session datée du jour, avec la note `Steam`, sur la dernière partie (playthrough) du jeu dans Backloggd. Si le jeu n'a pas encore de partie, il est ajouté à « Playing » et une partie est créée.

Le premier passage ne fait que mémoriser le point de départ : rien de ton historique n'est importé.

### Jeux émulés sur Steam Deck (Steam ROM Manager, EmuDeck)

Steam cache le nom des jeux non-Steam à son API publique : elle voit seulement « In non-Steam game ». Un petit service tourne donc sur le Deck (`deck/`). Aux 30 secondes, il cherche un processus dont la ligne de commande contient un chemin de ROM (EmuDeck les range sous `.../Emulation/roms/`). Il compte le temps pour ce jeu et envoie le total du jour au site. Le temps où le Deck est en veille n'est pas compté.

- Le nom vient du fichier de la ROM, sans les étiquettes de région ou de version : `SoulCalibur II (USA).rvz` devient `SoulCalibur II`.
- Si le Deck est hors ligne, les totaux attendent et partent au prochain envoi réussi.
- Ces jeux apparaissent dans `unmapped` sous une clé comme `ns:SoulCalibur II`, à utiliser comme `appid` dans l'action `map`.

Installation, en mode Bureau, dans Konsole :

```sh
git clone https://github.com/jethequeen/steam-backloggd-sync.git
cd steam-backloggd-sync/deck && ./install.sh
```

Le script demande l'adresse du site et le `SYNC_TOKEN`, puis installe un service qui démarre avec le Deck, en mode Jeu comme en mode Bureau. Pour vérifier ce qu'il détecte pendant qu'un jeu tourne : `python3 ~/.local/bin/backloggd-watch.py --scan`. Journal en direct : `journalctl --user -u backloggd-watch -f`.

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
curl -X POST -H "Authorization: Bearer $SYNC_TOKEN" -d '{"action":"map","appid":"ns:SoulCalibur II","slug":"soulcalibur-ii"}' https://<site>.netlify.app/api/control

# Total du jour pour un jeu émulé (ce que le service du Deck envoie)
curl -X POST -H "Authorization: Bearer $SYNC_TOKEN" -d '{"action":"play","name":"SoulCalibur II (USA)","date":"2026-10-13","minutes":45}' https://<site>.netlify.app/api/control

# Remplacer le cookie Backloggd sans redéployer
curl -X POST -H "Authorization: Bearer $SYNC_TOKEN" -d '{"action":"cookie","value":"..."}' https://<site>.netlify.app/api/control
```

Quand un titre Steam correspond à plusieurs jeux sur Backloggd (ou à aucun), rien n'est deviné. Le jeu apparaît sous `unmapped` avec des candidats, et ses minutes restent en attente jusqu'à ce que tu l'associes.

## Développement

```sh
npm install
npm test
```
