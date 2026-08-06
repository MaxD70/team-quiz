# Deploying Team Quiz to an existing EKS cluster

Same app, containerised. The persistence layer is unchanged: `store.js` still writes a
JSON file, but `DATA_FILE` points at an EBS-backed PVC mounted at `/data`.

```
  player --HTTPS--> ALB (ACM cert) --HTTP--> Service --> Pod (node:3000)
                                                          |
                                                     PVC on EBS (/data/state.json)
```

## Why single replica

Game state lives in one process, keyed by room code, and the chart pins
`replicaCount: 1` with a `Recreate` strategy so two pods never contend for the RWO EBS
volume.

It used to say here that multiple replicas "would require a Socket.IO Redis adapter and
sticky sessions". **That was wrong**, and it is worth knowing why before someone tries it:

- The Redis adapter only relays _messages_ between replicas. It does not share game state.
- Sticky sessions are per _client_. They pin one player to a pod but say nothing about
  where their teammates land — a teammate on another pod is told the room doesn't exist.
- What is actually needed is _room affinity_: every connection for one game on one pod.
  Hashing the ingress on the room code is the right shape, but it doesn't work yet
  because room codes are generated at random by whichever pod handled the host's login.

See [`docs/scaling.md`](../../docs/scaling.md) for the full story and the fix.

**Do not raise `replicaCount` above 1.** You don't need to: ten concurrent games of ten
players is about a hundred sockets, which one small pod handles without noticing. Run
this on EKS because it is where the platform lives — not for scale.

## Before you deploy: the two things that will bite you

**1. The super-admin password.** Without it the super panel is LOCKED, so no admin
accounts exist, so **nobody can host a game**. The pod starts, `/healthz` returns 200,
and the app is unusable. Earlier versions of this chart didn't set it at all.

```bash
helm upgrade --install team-quiz deploy/helm/team-quiz -n early-talent \
  --set app.superAdminPassword="$(openssl rand -base64 24)"   # then store it in a password manager
```

**2. Admin accounts must be persisted.** They live in `ADMINS_FILE` on the PVC. If that
volume goes, so do the accounts. Setting `redis.url` moves them off the pod's filesystem
entirely — worth doing even with a single replica, and the app seeds Redis from an
existing `admins.json` on first boot, so nothing is recreated by hand.

## A PodDisruptionBudget with one replica will hurt you

The chart ships with the PDB **disabled**, and refuses to render one alongside
`replicaCount: 1` unless you explicitly opt in. With a single pod, any PDB requiring it
to stay available makes eviction impossible to satisfy: node drains hang and every AMI
upgrade ends in `PodEvictionFailure`. Enable the PDB when — and only when — replicas
become safe.

## Cluster prerequisites

- **AWS Load Balancer Controller** (for the ALB Ingress).
- **EBS CSI driver** and a `gp3` StorageClass (adjust `persistence.storageClass` if yours
  is named differently, e.g. `ebs-sc`).
- An **ACM certificate** for `quiz.massimodanieli.com` in the ALB's region (eu-west-2),
  in status _Issued_. Validate it with a DNS record (add the CNAME ACM gives you in
  Cloudflare).

## 1. Build and push the image to Artifactory

```bash
ART=your-artifactory.example.com/docker-local
docker login your-artifactory.example.com

# If you build with buildx/BuildKit, disable provenance attestations so the push is a
# plain image manifest (avoids the manifest-list issues you hit on ECR):
docker build --provenance=false -t $ART/team-quiz:1.12.0 .
docker push $ART/team-quiz:1.12.0
```

## 2. Namespace + image pull secret

```bash
kubectl create namespace early-talent

kubectl -n early-talent create secret docker-registry artifactory-cred \
  --docker-server=your-artifactory.example.com \
  --docker-username='<user>' \
  --docker-password='<token>'
```

## 3. Install the chart

Create a `my-values.yaml` (don't commit secrets):

```yaml
image:
  repository: your-artifactory.example.com/docker-local/team-quiz
  tag: '1.0.0'
imagePullSecrets:
  - name: artifactory-cred
ingress:
  host: quiz.massimodanieli.com
  certificateArn: arn:aws:acm:eu-west-2:<acct>:certificate/<id>
app:
  winScore: 3
  # sharedPassword: "letmein"   # or use app.existingSecret to reference a managed Secret
persistence:
  storageClass: gp3
  size: 1Gi
```

```bash
helm lint deploy/helm/team-quiz
helm template tq deploy/helm/team-quiz -f my-values.yaml   # eyeball the output
helm upgrade --install tq deploy/helm/team-quiz -n early-talent -f my-values.yaml
```

## 4. Point DNS at the ALB

```bash
kubectl -n early-talent get ingress tq-team-quiz \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'; echo
```

In Cloudflare add a **CNAME**: `quiz` -> that ALB hostname. Start with **DNS only**
(grey cloud). The ACM cert on the ALB is publicly trusted, so if you later want the
Cloudflare proxy on, use SSL mode _Full (strict)_.

Then open `https://quiz.massimodanieli.com` (players) and `/host.html` (host).

## Upgrades

```bash
docker build --provenance=false -t $ART/team-quiz:1.1.0 .
docker push $ART/team-quiz:1.1.0
helm upgrade tq deploy/helm/team-quiz -n early-talent -f my-values.yaml --set image.tag=1.1.0
```

`Recreate` means a few seconds of downtime while the pod swaps — fine for this.
Roll back with `helm rollback tq -n early-talent`.

## Operating

```bash
kubectl -n early-talent get pods,svc,ingress,pvc
kubectl -n early-talent logs deploy/tq-team-quiz -f
```

- Config: `WIN_SCORE` in the ConfigMap, `SHARED_PASSWORD` via the Secret.
- Question history persists on the PVC at `/data/state.json`; it survives pod restarts
  and reschedules. **Note:** an EBS volume is AZ-bound, so the pod will schedule in the
  volume's AZ. Reset the history any time from the host panel ("Reset question history").
- New question set / app change → rebuild image, bump tag, `helm upgrade`.

## Notes

- Migrating history from the EC2 box isn't needed (the new question set uses fresh ids).
  If you ever want to, copy its `state.json` into the PVC.
- WebSockets: the chart sets the ALB idle timeout to 3600s
  (`ingress.idleTimeoutSeconds`) so long-lived Socket.IO connections aren't dropped.

## Pre-flight checklist (run this before the session, not during)

```bash
# 1. Chart renders and is valid
helm lint deploy/helm/team-quiz
helm template team-quiz deploy/helm/team-quiz -n early-talent | kubectl apply --dry-run=client -f -

# 2. The pod is up and knows its own state
kubectl -n early-talent get pods -l app.kubernetes.io/name=team-quiz
kubectl -n early-talent port-forward svc/team-quiz 8080:80 &
curl -s localhost:8080/healthz | jq
```

`/healthz` is the one thing to look at:

```json
{ "status": "ok", "sets": 18, "rooms": 0, "admins": 1, "replica": "team-quiz-xxx", "redis": false }
```

- `sets: 18` — the question library loaded (a stray `._*.json` file from a macOS copy
  will crash this at startup; the loader now ignores dotfiles).
- **`admins: 1` or more** — if this is `0`, nobody can host a game. This is the single
  most important number on this page.
- `replica` — which pod answered. Useful the day room affinity lands.
