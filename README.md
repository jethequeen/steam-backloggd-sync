# steam-backloggd-sync

Inscrit automatiquement ton temps de jeu Steam comme sessions de jeu sur Backloggd.

Une fonction Netlify planifiée (`netlify/functions/sync.mjs`) s'exécute aux 5 minutes :

1. Elle lit le temps de jeu total de chaque jeu via l'API Web Steam (`GetOwnedGames`).
2. Elle compare avec la lecture précédente, gardée dans Netlify Blobs, et additionne la différence au total du jour pour chaque jeu.
3. Dès que ce total atteint 5 minutes (en dessous, il attend que le temps s'additionne ; après 3 jours il est abandonné), elle l'écrit dans une session datée du jour, sans note, sur la dernière partie (playthrough) du jeu dans Backloggd. Si le jeu n'a pas encore de partie, il est ajouté à « Playing » et une partie est créée. Le site retient l'identifiant de chaque session écrite pour la retrouver ; les anciennes sessions notées `Steam` perdent la note à leur prochaine mise à jour.

Le premier passage ne fait que mémoriser le point de départ : rien de ton historique n'est importé.

### Jeux émulés sur Steam Deck (Steam ROM Manager, EmuDeck)

Steam cache le nom des jeux non-Steam à son API publique : elle voit seulement « In non-Steam game ». Un petit service tourne donc sur le Deck (`deck/`). Aux 30 secondes, il cherche un processus dont la ligne de commande contient un chemin de ROM (EmuDeck les range sous `.../Emulation/roms/`). Il compte le temps pour ce jeu et envoie le total du jour au site. Le temps où le Deck est en veille n'est pas compté.

- Le nom vient du fichier de la ROM, sans les étiquettes de région ou de version : `SoulCalibur II (USA).rvz` devient `SoulCalibur II`.
- Si le Deck est hors ligne, les totaux attendent et partent au prochain envoi réussi.
- Ces jeux apparaissent dans `unmapped` sous une clé comme `ns:SoulCalibur II`, à utiliser comme `appid` dans l'action `map`.
- Les jeux Steam lancés sur le Deck sont suivis de la même façon (processus `SteamLaunch AppId=…`). Le temps tombe ainsi sur le bon jour même si le jeu reste ouvert pendant une mise en veille. Pendant 24 h après un rapport du Deck pour un jeu, le temps de jeu que Steam rapporte pour ce jeu est ignoré, pour ne pas le compter deux fois.
- La première session d'un jeu est marquée « Started », sauf si le jeu était déjà marqué Played, Completed, etc. sur Backloggd.
- Quand tu mets un jeu à Played, Completed ou Retired sur Backloggd, sa dernière session est marquée comme fin (« Finished ») au passage suivant, dans l'heure. Shelved et Abandoned ne marquent rien.
- La page a trois onglets : Aperçu (statistiques, jeu en cours, plus joués, par plateforme et appareil), Jeux (jaquettes, filtrables par plateforme) et Journal (passages, envois en attente, dernier contact du Deck et du téléphone). Les statistiques couvrent ce qui a été envoyé à Backloggd depuis que l'historique existe, plus les deux semaines précédentes.
- Dans l'onglet Jeux, « Sessions » sous une jaquette liste les sessions envoyées par le site : chacune peut être supprimée (ici et sur Backloggd ; son temps n'est plus renvoyé, le jeu qui suit le même jour fait une nouvelle session). « Supprimer le jeu » retire toutes ses sessions de Backloggd, et le jeu de la bibliothèque s'il n'y a rien d'autre au propriétaire dessus (note, critique, autres sessions, marqué joué). Le jeu va dans « Jeux supprimés » : plus rien n'est envoyé pour lui tant qu'il n'est pas rétabli. Un jeu « À choisir » peut aussi être supprimé avant d'être associé (bouton « Supprimer » de sa carte) : son temps en attente n'est pas envoyé et il va dans la même liste.
- Sur la page, « Changer » sous une jaquette (onglet Jeux) permet de changer la fiche d'un jeu déjà associé : le jeu repasse dans « À choisir ». Les sessions déjà inscrites restent sur l'ancienne fiche.

Installation, en mode Bureau, dans Konsole :

```sh
git clone https://github.com/jethequeen/steam-backloggd-sync.git
cd steam-backloggd-sync/deck && ./install.sh
```

Le script demande l'adresse du site et le `SYNC_TOKEN`, puis installe un service qui démarre avec le Deck, en mode Jeu comme en mode Bureau. À la fin, il affiche le résultat d'un test de connexion au site (OK ou la raison de l'échec) et l'état du service. Pour mettre à jour : `cd ~/steam-backloggd-sync && git pull && bash deck/install.sh`. Pour vérifier ce qu'il détecte pendant qu'un jeu tourne : `python3 ~/.local/bin/backloggd-watch.py --scan`. La page du site indique aussi quand le Deck l'a contacté pour la dernière fois. Journal en direct : `journalctl --user -u backloggd-watch -f`.

### Jeux Switch sur téléphone Android (Eden)

Eden garde un total cumulé par jeu dans `Android/data/dev.eden.eden_emulator/files/play_time/playtime.bin` (entrées de 16 octets : Title ID puis secondes, en uint64 little-endian). Ce dossier n'est lisible qu'avec Shizuku, donc un script Termux (`android/`) le lit avec `rish`. Aux 15 minutes (`termux-job-scheduler`), il compare les totaux avec ceux du passage précédent, ajoute la différence au jour même et envoie le total du jour au site, comme le Deck. Les noms viennent de [titledb](https://github.com/blawar/titledb) (une recherche par nouveau jeu), la plateforme est Switch.

- Si `rish` échoue (Shizuku s'arrête à chaque redémarrage), une notification Termux le dit ; elle disparaît au premier passage réussi.
- Le même jeu joué le même jour sur le Deck et le téléphone donne une seule session, la somme des deux.
- Le compte commence à l'installation : le temps déjà dans Eden n'est jamais envoyé.
- MacroDroid peut aussi lancer `~/.local/bin/backloggd-eden` à la fermeture d'Eden (plugin Termux:Tasker), pour un envoi immédiat.

Il faut l'app Termux:API et `rish` déjà configuré dans Termux. Installation et mise à jour, dans Termux :

```sh
curl -sL https://raw.githubusercontent.com/jethequeen/steam-backloggd-sync/main/android/install.sh | bash
```

Vérifier : `python ~/.local/bin/backloggd-eden.py --test` (Shizuku et site) ou `--scan` (totaux d'Eden avec les noms). Journal : `~/.local/state/backloggd-eden.log`. La page du site indique quand le téléphone l'a contacté pour la dernière fois.

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
