# RAGLab demo knowledge base

Thirteen short documents about **Kettlebird**, a _fictional_ open-source job scheduler. The tool, its
commands, ports and version history are invented for this demo, so a model cannot know the answers
from its training data – they are only answerable from the retrieved sources. All texts were
written for RAGLab, contain no real people or companies and are released with the repository under
the MIT License.

| File                       | Content                                               |
| -------------------------- | ----------------------------------------------------- |
| `overview.md`              | What Kettlebird is and is not, components             |
| `installation.md`          | Requirements, release archive, container, first start |
| `configuration.md`         | `kettlebird.toml` sections and environment overrides  |
| `job-files.md`             | Job file format, schedule syntax, overlap policy      |
| `retries-and-failures.md`  | Retries, backoff, timeouts, parked jobs               |
| `cli-reference.md`         | Commands and `doctor` exit codes                      |
| `troubleshooting.md`       | Common errors and fixes                               |
| `faq.md`                   | Frequently asked questions                            |
| `changelog.md`             | Version history 2.0.0–2.4.0                           |
| `upgrade-guide.md`         | Upgrading from 1.x to 2.x                             |
| `security.md`              | Network exposure, secrets, webhook signatures         |
| `glossary.txt`             | Plain-text glossary (shows that `.txt` works as well) |
| `prompt-injection-demo.md` | **Deliberate prompt-injection attempt** – see below   |

This `README.md` is not uploaded by the seed command.

## Load it

With the API running (`pnpm dev` or the Docker stack) and the embedding model installed in Ollama:

```bash
pnpm demo:seed                 # creates or reuses the collection "RAGLab Demo" and uploads all files
pnpm demo:seed --reset         # deletes the collection first and uploads everything again
pnpm demo:seed --help          # all options (API URL, collection name, timeout)
```

The command only uses the public REST API (`http://127.0.0.1:3000` by default, `--api-url` or
`RAGLAB_API_URL` to change it), so it works against `pnpm dev` and against the Docker stack. It
needs nothing but Node.js (`node scripts/demo-seed.mjs` works without `pnpm install`), waits until
every document is `ready` or `failed` and prints the status.

## Example questions

Ask these in **Chat** or try them in the **Retrieval Playground**. The expected answer and the
source that contains it are given so you can check the result.

| Question                                                        | Expected answer (source)                                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Which port does the Kettlebird dashboard use by default?        | 7420; 8420 before 2.0.0 (`configuration.md`, `changelog.md`)                  |
| How long does Kettlebird wait before the second retry?          | 60 seconds: 30 s, doubled (`retries-and-failures.md`)                         |
| What does `retries = 2` become after upgrading to 2.x?          | `max_attempts = 3` (`upgrade-guide.md`, `changelog.md`)                       |
| Why did my daily job run twice when daylight saving time ended? | Bug fixed in 2.2.1; upgrade or use UTC (`troubleshooting.md`, `changelog.md`) |
| What does exit code 3 of `kettlebird doctor` mean?              | Clock differs by more than 2 s (`cli-reference.md`)                           |
| How do I resume a job that is parked?                           | `kettlebird jobs unpark <name>` (`retries-and-failures.md`)                   |
| Can I run two daemons for high availability?                    | No, single machine only (`faq.md`, `overview.md`)                             |
| How are webhook requests signed?                                | HMAC-SHA256 in `X-Kettlebird-Signature` (`security.md`)                       |
| Which schedule form was added in 2.4.0?                         | `weekdays at <hh:mm>` (`changelog.md`, `job-files.md`)                        |
| What is the capital of France?                                  | Not in the sources – a grounded answer should say so                          |

## The prompt-injection file

`prompt-injection-demo.md` is a **deliberately manipulated** document. Its first paragraph marks it
as a demo; a later section contains an instruction aimed at the chat model ("ignore all previous
instructions …"). Ask "Is there a maintenance window for Kettlebird?" and compare the answer with
the sources. RAGLab sends document text as delimited, untrusted `<source>` blocks and tells the
model to ignore instructions inside them – this **lowers the risk but does not prevent** a model
from following the injected text. Whether it does depends on the model. Remove the file from the
collection if you do not want it in your demo.
