# CareBell

CareBell is a door-watch app for people who are deaf or hard of hearing, older adults living alone, and the family who look after them.

A Ring doorbell already sees the door. CareBell turns that into large words, color, and sound the household can act on: someone at the door, a package left behind, a knock, someone waiting, or someone who may have fallen. Today becomes one plain sentence. The family log keeps the rest. A named person can be recognized from photos saved here. A stranger is not named.

It talks to Ring only through official Ring APIs (`https://api.amazonvision.com`). Door clips and pictures are read on this computer. They are not sent back to Ring. Subscriptions and Chime volume stay in the Ring app.

## What it watches

When the doorbell saves a recording, CareBell reads frames on **this computer**. It does not send those clips back to Ring.

- Someone pressed the doorbell
- Someone at the door
- A package left at the door
- Someone may have fallen
- The same person waiting near the door for one minute
- Someone knocking at the door

A person you named can be recognized from photos saved on this server. A stranger is not named. CareBell does not listen for a knock.

## How OpenCV and the models work

Ring does not send a package, fall, knock, or waiting event. Official history only reports `ding`, `motion`, and `on_demand`. CareBell downloads the clip or still for that moment, then looks at it **on this computer**. The file is not sent back to Ring.

1. **ffmpeg** pulls JPEG frames from the MP4.
2. **OpenCV.js** (`@techstark/opencv-js`) resizes the porch, finds motion, and looks for a leftover parcel (brown or pale carton on a dark step, rectangle contours). It also finds person-shaped silhouettes when the models miss them.
3. **YOLOv8n** (`models/yolov8n.onnx`) marks person, package, and vehicle boxes. ONNX Runtime runs it locally.
4. **MoveNet Lightning** (`models/movenet-lightning.onnx`) reads pose on the doorstep crop. A drop into a low, still posture can become a fall. A downed person is not treated as a package.
5. The event heads combine those tracks over time: a leftover box is a package, repeated motion at the door can be a knock, and the same person near the door for one minute is waiting.

The two ONNX files download into `models/` the first time door vision runs. OpenCV loads once in process. You can also send a file to [http://127.0.0.1:3780/opencv](http://127.0.0.1:3780/opencv); the same pipeline runs and the alert shows on Door.

## Requirements

- Node.js 18 or newer
- A Ring Developer account if you want live doorbell events
- Optional: a Gemini API key if you want a written sentence turned into a care rule

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

## Test it (for judges or a new machine)

No password is stored in this repo. Create your own CareBell account on first open (name, email, password at least 8 characters).

### Without Ring or Gemini

Start the server, open [http://127.0.0.1:3780](http://127.0.0.1:3780), and create an account. With no Playground token, Door shows practice events (doorbell, person, package, fall, waiting, knock, missed check-in). Tap **I have seen this**. Check Today, the family log, People, and Care. Practice buttons hide once a Ring token is connected.

### Ring Playground (live door)

1. Generate a token at the [Ring Playground](https://developer.amazon.com/ring/console/playground). It lasts about 30 minutes.
2. In CareBell, open **Care**, paste the token, and connect. The token stays on this server and is not shown again. Do not commit it.
3. In Playground, send a **package**. Within about 20 seconds, Door should show **A package is at the door**, not a doorbell press. Playground still delivers that send as a Ring `ding`; OpenCV and the models relabel it from the clip.
4. **Look now** opens the official WHEP live stream.
5. Optional: [http://127.0.0.1:3780/opencv](http://127.0.0.1:3780/opencv) has the same token field and a file picker for an MP4 or JPEG.

Ring OAuth client id and secret are not required for Playground testing. DynamoDB and Bedrock are not required.

### Gemini key from the lab (optional)

Gemini is only used on **Care → Alert rules → Fill the choices**. Preset rules work without a key.

1. Open [Google AI Studio](https://aistudio.google.com/) (the Gemini lab) and sign in with a Google account.
2. Accept the terms if asked.
3. Open [API keys](https://aistudio.google.com/apikey) and click **Create API key**. New users usually get a default project and key.
4. If the workshop or lab machine already shows a Gemini key, use that value instead.
5. Put it in `.env` as `GEMINI_API_KEY=...` and restart `npm start`. Do not commit the key.
6. On Care, **Fill the choices** appears. Try `Alert me if someone is at the door after 21:00`. A sentence about lights or locks should be refused.

## Privacy

Door photos, clips, account hashes, and Ring tokens live under `data/` on this server. That folder is not part of the git repo. Subscriptions and Chime volume stay in the Ring app.

## License

MIT. See [LICENSE](LICENSE).
