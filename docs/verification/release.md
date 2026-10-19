# Release a reviewed package

The release workflow prepares a candidate, proves the installed package against the reference app, and records its SHA-512 integrity. A version tag alone never publishes to npm. A maintainer reviews the artifact before CI stages those exact bytes; a separate npm approval makes the version public.

The public repository is [testlane-dev/testlane](https://github.com/testlane-dev/testlane). Release tags and npm provenance must refer to its sanitized history. Keep private assessment notes and development history out of the initial public push: use the reviewed output of `node scripts/export-public.mjs <new-empty-directory> --release`, initialize a new Git repository in that export, and review its initial commit before publishing it. Do not push the private repository's branches or tags to the public remote.

## Before creating a candidate

1. Merge the release changes, update `CHANGELOG.md`, and commit the intended `package.json` and lockfile version. Use a fresh public checkout with no uncommitted files.
2. Confirm the main CI run passed, including Windows/Linux real-broker proofs and the macOS temporary-keychain adapter tests. The compatibility guide records the limits of these checks; protocol tests do not certify every coding-agent client version.
3. Configure the GitHub `npm-release` environment with required maintainer review and version-tag deployment rules. The workflow names this environment, but the repository settings must enforce its protection.
4. Configure an npm trusted publisher for the package: GitHub owner `testlane-dev`, repository `testlane`, workflow filename `publish.yml`, environment `npm-release`. Allow staging only; leave direct publication and dist-tag management disabled. No `NPM_TOKEN` repository secret is needed. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

The workflow pins npm 11.21.0 on Node 22 and uses GitHub-hosted runners. It grants OIDC permission only to the staging job, disables dependency caching in release jobs, and does not install or build the source in that privileged job. Package-level publishing access should require 2FA and disallow traditional tokens after bootstrap. Create a new trust configuration close to the intended release: npm requires its first successful publication within two days.

## First-package bootstrap

This section applies only while `@testlane/cli` does not exist. Confirm the intended maintainer has publishing access to the `@testlane` scope before proceeding. The CLI remains `testlane`; npm creates scoped tarballs named `testlane-cli-<version>.tgz`. The unscoped `testlane` name was rejected by the registry, so do not retry that name or alter the retained 0.5.1 tag/artifacts.

**Staging a new package is already a public action:** npm creates a visible `0.0.0-stage` placeholder, although the uploaded candidate stays private until approved. Obtain launch approval before this bootstrap. Do not approve the local bootstrap stage, because the final candidate will be staged from GitHub with provenance.

1. Download the successful public candidate run's artifact and review `release-manifest.json`, the file inventory, and `consumer-proof.txt`. Verify it with the command in the next section.
2. In a trusted human terminal, use npm 11.21.0, authenticate with `npm login --auth-type=web --registry=https://registry.npmjs.org`, and complete account 2FA setup if required. Do not paste passwords, tokens, or one-time codes into an issue, workflow input, or coding-agent conversation.
3. Stage the reviewed tarball locally, without approving it:

   ```sh
   npm stage publish ./output/release/testlane-cli-0.6.0.tgz --ignore-scripts --access public --tag latest --registry=https://registry.npmjs.org
   ```

4. Configure the stage-only GitHub trusted publisher described above now that the package exists. If npm does not expose settings for the placeholder, stop and resolve that with npm before continuing; do not publish a substitute real version to work around it.
5. Reject the local bootstrap stage using the npm website or `npm stage reject <stage-id>` with human 2FA. A rejected stage can be staged again; an actually published name/version cannot be reused. Confirm the pending local stage is gone before dispatching CI.
6. Continue with the normal candidate dispatch below. Its OIDC stage carries the public GitHub provenance; review and approve that stage only.

The [npm stage command reference](https://docs.npmjs.com/cli/v11/commands/npm-stage/) documents tarball inputs, stage rejection/re-staging, and separate human approval. [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/) requires the package to exist before trust can be configured. Account authentication and package/team permissions remain human-controlled setup steps.

## Prepare and review

Create and push `v0.6.0` only after approving the public source commit. The `Release candidate` tag run checks macOS, then builds and packs once on Linux. It exercises the packed CLI's diagnostics, MCP session-file delivery and cleanup, and both browser workflows against real HTTP sign-in and an isolated native Secret Service keyring. It verifies the same tarball again afterward and uploads `release-v0.6.0` for 14 days. The manifest records its source commit, producing run ID, complete package file inventory, and SHA-512 integrity.

A local preparation is useful before the tag; it publishes nothing:

```sh
npm ci
npm run typecheck
npm test
npm run build
node scripts/export-public.mjs --check --release
node --test scripts/release-artifact.test.mjs
node scripts/release-artifact.mjs prepare --directory output/release
node scripts/release-artifact.mjs verify --directory output/release --tag v0.6.0
```

The destination must be new. `prepare --allow-dirty` permits an explicitly marked local review build, but release verification rejects it unless the same local-only override is supplied. Do not dispatch or stage a dirty build. Change the directory for each new candidate; do not overwrite a reviewed tarball.

After downloading the GitHub artifact into `output/release`, verify against the **previously reviewed** manifest values, substituting its integrity, public source commit and run ID:

```sh
node scripts/release-artifact.mjs verify --directory output/release --integrity 'sha512-<reviewed-base64-digest>' --commit '<public-source-commit>' --tag v0.6.0 --run-id '<candidate-run-id>'
```

Use the literal SHA-512 value from the trusted review record, including the `sha512-` prefix. Copying a new digest from an unreviewed replacement only verifies that replacement against itself. Review the tarball contents as well as the generated file inventory; integrity binds bytes, not their safety.

## Stage, approve, and verify

1. Manually run `Release candidate` **at the reviewed version tag**. Set `release_tag`, `artifact_run_id`, the reviewed `integrity`, and the intended npm `dist_tag` (`latest`, `next`, or `beta`). For example:

   ```sh
   gh workflow run publish.yml --repo testlane-dev/testlane --ref v0.6.0 \
     -f release_tag=v0.6.0 \
     -f artifact_run_id='<candidate-run-id>' \
     -f integrity='sha512-<reviewed-base64-digest>' \
     -f dist_tag=latest
   ```

   The workflow accepts artifacts only from a successful tag-triggered run of this workflow whose commit matches the selected tag. Both verification jobs also require the dispatch's `GITHUB_REF` to equal `refs/tags/<release_tag>` and `GITHUB_SHA` to equal the manifest's source commit, keeping npm provenance aligned with the reviewed package. The reviewed integrity is checked before and after the GitHub environment approval gate.
2. Review the `npm-release` environment approval. The job downloads and stages the existing tarball with `--ignore-scripts --provenance`; it never rebuilds or republishes from the source directory. Staging is the only npm operation CI performs.
3. In npm's Staged Packages tab, review the version, tag, tarball and provenance against the GitHub candidate. Approve with human 2FA only when they match. [npm staged publishing](https://docs.npmjs.com/staged-publishing/) keeps this final decision outside CI.
4. Confirm the public registry's `dist.integrity` equals the reviewed SHA-512 value and its provenance names the intended public repository/run. In a new project, install the exact version and exercise the quickstart. `npm audit signatures` can verify registry signatures and supported provenance from the installed dependency tree. See [npm provenance generation](https://docs.npmjs.com/generating-provenance-statements/).
5. Create the GitHub release for that same tag with the tarball, `release-manifest.json` and `consumer-proof.txt`. Link any additional platform/client proofs recorded against those exact bytes. Readers should use that release's manifest and proofs for version-specific evidence; historical compatibility observations do not verify a replacement artifact. Then publish the approved announcements using the working npm and repository links.

If staging fails, keep the candidate intact and resolve authentication, trust or tag errors before retrying. If a staged version needs different bytes or a different dist-tag, reject it with human 2FA before re-staging. After a version is published, use a new patch version for fixes; do not treat unpublishing as a replacement mechanism. A failed consumer proof or mismatched integrity stops the release.
