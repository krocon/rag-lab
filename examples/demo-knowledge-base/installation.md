# Installing Kettlebird

## Requirements

- A 64-bit Linux or macOS machine (x86-64 or ARM64).
- At least 128 MB of free memory and 200 MB of disk space for the state database.
- Write access to a state directory (default: `/var/lib/kettlebird` on Linux,
  `~/Library/Application Support/kettlebird` on macOS).

Windows is not supported natively; run the Linux build inside WSL.

## Install from the release archive

1. Download the archive for your platform from the project's release page, for example
   `kettlebird-2.4.0-linux-arm64.tar.gz`.
2. Verify the checksum against the published `SHA256SUMS` file:
   `sha256sum --check --ignore-missing SHA256SUMS`.
3. Extract the binary and move it into your `PATH`, for example to `/usr/local/bin/kettlebird`.
4. Run `kettlebird version` – it should print `kettlebird 2.4.0`.

## Run it in a container

The project publishes a container image named `kettlebird/kettlebird` with tags per minor version
(`2.4`) and per patch version (`2.4.0`). Mount the state directory and the job directory:

```bash
docker run -d --name kettlebird \
  -p 127.0.0.1:7420:7420 \
  -v kettlebird-state:/var/lib/kettlebird \
  -v ./jobs:/etc/kettlebird/jobs:ro \
  kettlebird/kettlebird:2.4
```

The image runs as user `kettlebird` (UID 10001), not as root.

## First start

Create a configuration with `kettlebird init`. It writes `kettlebird.toml` and an example job
`jobs/hello.toml` into the current directory. Then start the daemon:

```bash
kettlebird init
kettlebird serve --config ./kettlebird.toml
```

Open `http://127.0.0.1:7420/dash` to see the dashboard. The example job prints `hello` every
minute; delete `jobs/hello.toml` once you have added your own jobs.

## Uninstalling

Stop the daemon, remove the binary and delete the state directory. Kettlebird does not install
system services by itself, so there is nothing else to clean up unless you created a service unit.
