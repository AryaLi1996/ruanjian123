# Cloud inpainting service

The learned filler the desktop app cannot afford to run locally.

The app is [AryaLi1996/watermaker-removal-123](https://github.com/AryaLi1996/watermaker-removal-123); its `backend/dewatermark.py`
recovers what it can by arithmetic and `backend/cloud_fill.py` is the client
half of this service. The service lives *here*, beside the licence service,
because what decides who may use it — `fill/quota` — is a question about an
account, and that is where accounts are.

## Why it is here

Undoing the blend recovers most of the picture arithmetically, on any machine,
in milliseconds. What is left is the few percent of pixels the mark covered
opaquely, and filling those with a diffusion inpainter leaves a trace that is
still legible: measured against the mark's own shape, 0.081 where the untouched
input reads 0.866 and a clean region reads 0.

A learned filler takes that to -0.001 +- 0.071 — indistinguishable from no mark
at all. It costs about a second a frame on four CPU cores, which is an hour for
a two-minute clip, so it does not belong on the user's machine.

**On faithfulness, read the next section before trusting any number here.**
This file used to claim 6.65 levels of error against known frames, against 6.79
for the local filler. That figure could not be reproduced the first time the
image was actually built and run: with the code as it stood the service
measured **90.07 +- 44.96** levels against **8.12 +- 4.67** for the local
filler — an order of magnitude *worse* than the thing it exists to replace. The
cause was in `inpaint.py`, it is fixed, and at 1:1 the service now measures
**6.11 +- 3.08**. The legibility figure above is left as it was found and has
not been re-measured here; the fidelity figures are ones this repository can
reproduce.

The lesson is worth keeping: legibility — how much of the mark's shape is left
— goes *down* when a filler invents smooth nonsense, so it cannot on its own
tell a good fill from a confident wrong one. Error against a known frame can,
and is what the tests now pin.

## What crosses the network

The marked rectangle only. On the clip this was developed against that is
119x68 pixels of a 320x568 frame — the service never receives the rest of the
picture, and cannot reconstruct it. The mask is one image for the whole job.

    WebP q90, 2.7 KB a frame:  9.5 MB up and the same down for a 2-minute clip
    the whole video file, for comparison:  11.9 MB

## Running it locally

    pip install -r requirements-dev.txt
    FILL_SIGNING_SECRET=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))') \
    LAMA_ONNX=/path/to/lama.onnx python -m uvicorn app:api --port 8000

The tests and a local run want Python 3.12 or newer, which is what the
deployed image runs — see the Dockerfile for why 3.11 is not an option.

The model is not vendored here: it is a 208 MB file, and where it lives is a
deployment decision. `Carve/LaMa-ONNX` on Hugging Face is the one these numbers
were measured with, and the deployed image bakes in that repository's
`lama_fp32.onnx` at a pinned commit with its checksum verified — see
`Dockerfile`.

Every route but `/health` wants a bearer token. Mint one for a local run with
the same function the licence service is specified to use:

    python3 -c "import auth, time; print(auth.sign({'app':'shuyin','sub':'me','exp':time.time()+3600}, '<the secret>'))"

The tests are the fast way to check a change:

    python -m unittest discover -p 'test_*.py' -v

None of them needs the model.

## Deploying it

`template.yaml` is the whole deployment: one Lambda, built from `Dockerfile`,
behind a Function URL. `../../scripts/deploy-inpaint.sh` applies it, and
`.github/workflows/deploy-license.yml` is how it is meant to be applied — the
same workflow that deploys the licence service, which plans and applies this
stack too when this directory changes. Test, then a change-set a reviewer
reads, then an apply that reviewer released.

`../verify-license/CI_DEPLOY_SETUP.md` is the one-time AWS and GitHub setup,
shared by both stacks.

**A Lambda, not a GPU instance.** With no users yet, an always-on
`g4dn.xlarge` is about $380 a month to answer nothing, and this is $0. The
client's answer to an unreachable service is to fill locally and say so, so the
cheap option's failure mode is a slower, slightly more legible export rather
than a broken one. The next section is the cost of that choice, and how to
reverse it.

## How the patch is handed to the model, and why it is not scaled up

`_to_model_frame` pads a patch out to the 512-square the exported graph insists
on, and never scales it up. That is the fix described above, and it is the one
thing in this service worth being careful about, so the numbers are here:

    1:1 (what it does)      6.11 +- 3.08 levels of error against the truth
    2x                    126.49 +- 63.77
    3x                     88.89 +- 49.07
    scaled to fill 512     90.07 +- 44.96
    the local filler        8.12 +- 4.67

Twenty-four regions of three frames of the sample clip, a watermark-shaped
stroke mask, error measured only inside the mask. Scaling down is still done
when a patch is larger than the graph's input — it has nowhere else to go.

`ModelFrameTest` in `test_app.py` pins this without needing the model, which is
what makes it a test the pre-deploy gate can run.

## How long a batch takes

Inference is about a second a frame on four CPU cores. The deployed Lambda runs
at 10240 MB, which buys roughly six, so a 240-frame batch is minutes rather
than the few seconds the same batch takes on a GPU.

That number is why the client has no flat timeout. A flat 120 seconds would
have abandoned every single batch this deployment answered — a service that is
up, working and being given up on, which from the app's side is
indistinguishable from one that is down. The client budgets per batch
(`cloud_fill.timeout_for`, in the app's repo) and bounds what a genuinely hung
service can cost by giving up on it for the rest of the export after one
failure.

So on this deployment an export is *slow* and the picture is right. The
quality numbers above are the model's, and the model is the same one either
way; only the waiting differs.

**Moving to a GPU costs one environment variable**, on the licence service, and
nothing on any installed client: the app is handed the endpoint per export by
whatever just decided the export was allowed — so it is one stack output, read
by `deploy-license.sh` and passed to the licence function as
`FILL_ENDPOINT_URL`. Point that at a GPU endpoint and every installed client
follows on its next export. Do it when people are waiting; there is nothing to
prepare beforehand.

## What it is not

Accounting is not here, and should not be. `fill/quota` and `fill/consume` in
`../verify-license/handler.py` answer "who is entitled to what", beside every
other question about an account. This service checks a token that function
minted (`auth.py`) and holds no account state at all — no table, no bucket, no
secret store, which is what its execution role says too.

## Where it runs

AWS account `641628981129`, `us-east-1` — the same account as the licence
service, so what keeps this public endpoint away from the tables holding
licences and orders is IAM rather than an account boundary. The function's
execution role grants nothing but logs, which is the part that has to stay true
(`../verify-license/CI_DEPLOY_SETUP.md` §0). Which is a deployment detail everywhere except in
the app,
where it is the thing that decides what the user has to be told: for a user in
China, every export through this service is a cross-border transfer of personal
information, and PIPL article 39 asks for the overseas recipient by name, the
purpose and method, the categories, and how to exercise rights against that
recipient — with consent to that specifically, separately from anything else
they have agreed to. `renderer/src/cloud.ts` and
`CloudConsentDialog.tsx`, in AryaLi1996/watermaker-removal-123, are where that lives; moving the service into China would let both be shorter, and
moving it anywhere else changes neither.

The account number is recorded now, where it was deliberately left out before.
It is not a secret — it is a routing number, useless without credentials — and
`../../scripts/deploy-inpaint.sh` needs it to refuse a deployment aimed at the
wrong account, which is worth more than the small tidiness of leaving it out.

## Metering

The app asks before every export that would use this service, and tells it
afterwards what was used. Both routes live beside the licence ones on the
licence service (one base URL, dispatched by path suffix — `_request_path` in
`../verify-license/handler.py`), because who is entitled to what is a question
about an account, and that is where accounts already are.

**`POST fill/quota`** — may this export use the service?

    → { appId, deviceId, userId }
    ← { allowed:      true,
        limit:        100,              // included this period
        used:         12,
        remaining:    88,
        periodEnds:   "2026-10-01T00:00:00Z",
        overagePrice: "¥0.30",          // formatted by the service
        endpoint:     { url: "https://…/inpaint", token: "…" },
        reason:       null }            // a key the app has a sentence for,
                                        // when allowed is false

**`POST fill/consume`** — one export used it.

    → { appId, deviceId, userId, units }
    ← the same shape, with the new count

Two things about that shape are deliberate, and are the reason it is not three
constants in the app:

**Every number is the service's.** The allowance, the price beyond it, what
counts as one unit, when the period rolls over. Going from a hundred a month to
two hundred, changing the price, or charging per minute of video instead of per
export, is a change here and not a release everybody has to install. The app
renders what it is told and has no opinion.

**The endpoint comes back with the answer.** The app never holds a URL for this
service; it is given one per export, by the thing that just decided the export
was allowed. Turning the service off for everyone, or moving it, needs nothing
from the client.

The count is told after the fact rather than reserved before it, so what a user
is charged for is what they actually received: an export that fell back to the
local filler for every frame is not one of their hundred. And a service that
cannot be reached means the export is filled on the user's own machine — a
local count of something that costs money is a count that can be edited, and an
export that spends against a guess cannot be taken back.
