# CareBell

CareBell turns what a Ring doorbell sees into words a household can read, hear, and act on.

It is a door-watch app for people who are deaf or hard of hearing, older adults living alone, and the family members who care for them. Large text, bedside alerts, and spoken commands are first-class. CareBell talks to Ring only through official Ring APIs (`https://api.amazonvision.com`).

## What it watches

When the doorbell saves a recording, CareBell reads frames on **this computer**. It does not send those clips back to Ring.

- Someone pressed the doorbell
- Someone at the door
- A package left at the door
- Someone may have fallen
- The same person waiting near the door for one minute
- Someone knocking at the door

A person you named can be recognized from photos saved on this server. A stranger is not named. CareBell does not listen for a knock.

## Requirements

- Node.js 18 or newer
- A Ring Developer account if you want live doorbell events

Pose and person models download into `models/` the first time you run door vision.

## Setup

```bash
npm install
npm --prefix app install
```

Copy `.env.example` to `.env` and fill in only the keys you use. Tokens stay on this machine. They are not committed.

| Key | Used for |
| --- | --- |
| `RING_CLIENT_ID` | Ring app client id |
| `RING_CLIENT_SECRET` | Ring app client secret |
| `RING_HMAC_KEY` | Webhook signatures |
| `GEMINI_API_KEY` | Optional: fill a written care rule from a sentence |

In the Ring developer portal, point these paths at your public HTTPS address:

- Token exchange: `/oauth/token`
- Account link: `/ring/link`
- Webhook: `/webhooks/ring`

You can also paste a Ring Playground token on the Care page. The token stays on this server and is not shown again.

## Run

```bash
npm start
```

Open [http://127.0.0.1:3780](http://127.0.0.1:3780). Create an account, then use Door, Today, Family log, People, and Care.

The phone/web client:

```bash
npm start:app
```

That starts Expo on port 8081 and talks to the local CareBell server.

## Check

```bash
npm test
npm run typecheck
```

## Privacy

Door photos, clips, account hashes, and Ring tokens live under `data/` on this server. That folder is not part of the git repo. Subscriptions and Chime volume stay in the Ring app.

## License

MIT. See [LICENSE](LICENSE).
