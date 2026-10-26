# net_chart

Helm chart for **Bakrim** (repo folder: `streambert`) — a Vite + React web app served by nginx.

- Chart version: `0.1.0`
- App version: `2.6.0`
- Location: `C:\Users\idk\Desktop\net_chart`

## What it deploys

| Resource | Name (default) | Purpose |
|---|---|---|
| Deployment | `<release>-net-chart` | nginx pods serving the static build |
| Service | `<release>-net-chart` | ClusterIP on port 80 → container 8080 |
| Ingress | `<release>-net-chart` | Optional, `bakrim.ma` host, class `nginx` |
| ConfigMap | `<release>-net-chart` | `default.conf` (SPA fallback, gzip, `/healthz`, caching, security headers) |
| ServiceAccount | `<release>-net-chart` | Created unless `serviceAccount.create=false` |
| HPA | `<release>-net-chart` | Only when `autoscaling.enabled=true` |

The container runs as a non-root user (`101:101`) with a read-only root filesystem,
matching `nginxinc/nginx-unprivileged`, and probes `/healthz` on port `8080`.

## Build the image

The Dockerfile lives in the chart, but the build context is the app source:

```powershell
docker build -f C:\Users\idk\Desktop\net_chart\Dockerfile `
    -t localhost/bakrim:2.6.0 `
    C:\Users\idk\Desktop\homenet\streambert
```

A `.dockerignore` was added to `streambert/` so `node_modules/`, `dist/`, and
screenshots stay out of the build context. The image runs `npm ci` +
`npm run build:web` (Vite) and copies `dist/` into nginx.

For a plain `docker run` (without Helm), mount the nginx config yourself:

```powershell
docker run -p 8080:8080 -v C:\Users\idk\Desktop\net_chart\nginx.conf:/etc/nginx/conf.d/default.conf:ro localhost/bakrim:2.6.0
```

## Install (no registry needed)

The image never has to touch Docker Hub or GHCR: it is saved to a tarball,
copied to the server over SSH, and loaded straight onto the node. The chart
uses `pullPolicy: IfNotPresent`, so kubelet picks up the local copy instead
of pulling.

```powershell
# one-shot: build (if missing) -> docker save -> scp -> docker load / k3s ctr import
C:\Users\idk\Desktop\net_chart\Send-BakrimImage.ps1 -Server root@your-server

# then install/upgrade the chart
helm upgrade --install bakrim C:\Users\idk\Desktop\net_chart -n bakrim --create-namespace
```

The script works with a plain Docker host and with k3s-only servers (it falls
back to `sudo k3s ctr images import`, then `sudo ctr -n k8s.io images import`).

Manual equivalent, if you would rather do it by hand:

```powershell
docker build -f C:\Users\idk\Desktop\net_chart\Dockerfile -t bakrim:2.6.0 C:\Users\idk\Desktop\homenet\streambert
docker save -o bakrim-2.6.0.tar bakrim:2.6.0
scp bakrim-2.6.0.tar root@your-server:/tmp/
ssh root@your-server "docker load -i /tmp/bakrim-2.6.0.tar"      # or: sudo k3s ctr images import /tmp/bakrim-2.6.0.tar
```

No SSH access? Serve the tarball from this machine instead:

```powershell
python -m http.server 8000        # run in the folder holding the .tar
# on the server:
#   curl -O http://<windows-ip>:8000/bakrim-2.6.0.tar && sudo docker load -i bakrim-2.6.0.tar
```

## Install (with a registry)

```powershell
# load into kind/minikube first, e.g.
kind load docker-image localhost/bakrim:2.6.0

helm install bakrim C:\Users\idk\Desktop\net_chart -n bakrim --create-namespace
```

With a real registry and tag:

```powershell
helm upgrade --install bakrim C:\Users\idk\Desktop\net_chart -n bakrim --create-namespace `
    --set image.repository=registry.example.com/bakrim `
    --set image.tag=2.6.0 `
    --set ingress.enabled=true `
    --set ingress.hosts[0].host=bakrim.ma
```

## Key values

```yaml
replicaCount: 2
image:
  repository: localhost/bakrim
  tag: ""            # defaults to chart appVersion (2.6.0)
  pullPolicy: IfNotPresent

service:
  type: ClusterIP
  port: 80

ingress:
  enabled: true
  className: nginx
  hosts:
    - host: bakrim.ma
      paths:
        - path: /
          pathType: Prefix
  tls: []

autoscaling:
  enabled: false
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 80

nginx:
  gzip: true
  clientMaxBodySize: 16m
  configChecksumAnnotation: true   # roll pods on config change
  extraServerDirectives: ""        # raw directives added to the server block

resources:
  requests: { cpu: 50m, memory: 64Mi }
  limits:   { cpu: 500m, memory: 256Mi }
```

## Validate / debug

```powershell
helm lint C:\Users\idk\Desktop\net_chart
helm template bakrim C:\Users\idk\Desktop\net_chart | more
helm status  bakrim -n bakrim
kubectl logs -n bakrim deploy/bakrim-net-chart -f
```

## Notes

- The app does not use a URL router (single `App.jsx` view state), so the SPA
  fallback in nginx is a safety net rather than a requirement.
- `vite.config.js` builds with `base: "./"`, which works because the app is
  served from `/`.
- The chart's ConfigMap overrides the image's baked-in nginx config, so
  changing `values.yaml` nginx settings triggers a rolling restart via the
  `checksum/nginx-config` annotation.
