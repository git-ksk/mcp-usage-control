from pathlib import Path

replacements = {
    'README.md': [
        (
            '**The packages are not published to npm yet.** `v1.0.0` is the current stable GitHub/source release baseline. Until first registry publication, use the attached GitHub Release tarballs or a repository checkout. See **[Use from source / local tarballs](docs/using-from-source.md)**.',
            '**All five packages are published to npm at `1.0.0`.** `v1.0.0` is also the current stable GitHub/source release baseline. Install only the integration layer and Store backend you need; GitHub Release tarballs remain available as reproducible source-release artifacts. See **[Use from source / local tarballs](docs/using-from-source.md)** for non-registry workflows.'
        ),
        (
            'All five package manifests are aligned at `1.0.0`. **v1.0.0 is the current stable GitHub/source release baseline**; npm registry publication remains intentionally deferred.',
            'All five package manifests are aligned at `1.0.0`, and all five packages are published on npm. **v1.0.0 is the current stable GitHub/source and npm baseline.**'
        ),
    ],
    'README.ja.md': [
        (
            '**まだnpmへ公開していません。** `v1.0.0` がcurrent stable GitHub/source release baselineです。初回registry publishまではGitHub Release tarballまたはrepository checkoutを使います。詳しくは **[Source / local tarballから使う](docs/using-from-source.ja.md)** を参照してください。',
            '**5 packageすべてをnpmへ `1.0.0` として公開済みです。** `v1.0.0` はcurrent stable GitHub/source release baselineでもあります。通常は必要なintegration layerとStore backendだけをinstallしてください。GitHub Release tarballはreproducibleなsource-release artifactとして引き続き利用できます。non-registry workflowは **[Source / local tarballから使う](docs/using-from-source.ja.md)** を参照してください。'
        ),
        (
            '5 package manifestは `1.0.0` で揃っています。**v1.0.0がcurrent stable GitHub/source release baseline**で、npm registry publicationは引き続き意図的にdeferredです。',
            '5 package manifestは `1.0.0` で揃っており、5 packageすべてnpm公開済みです。**v1.0.0がcurrent stable GitHub/source / npm baseline**です。'
        ),
    ],
    'docs/v1-readiness.md': [
        (
            'The packages remain **unpublished to npm**. First registry publication is separately tracked by #6 and requires explicit authorization independent from source releases.',
            'All five packages were first published to npm as `1.0.0` on 2026-09-04 after the separately authorized #6 publication gate. Registry metadata, integrity, signed provenance, and clean-consumer installation were verified after publication.'
        ),
        (
            'The v0.11 completion tranche is closed. Issue #6 remains a separate publication gate and runs only when explicitly authorized; it is not implicitly authorized by a source release.',
            'The v0.11 completion tranche is closed. The separate #6 publication gate was explicitly authorized and completed for `v1.0.0`; future registry releases continue to use the manual publication workflow rather than being implied by source releases.'
        ),
    ],
    'docs/v1-readiness.ja.md': [
        (
            'packageは **npm未公開** です。first registry publicationは#6で別途追跡し、source releaseとは独立したexplicit authorizationが必要です。',
            '5 packageすべてを2026-09-04にnpmへ `1.0.0` として初回公開済みです。#6のseparate publication gateを明示authorizeして実行し、公開後にregistry metadata / integrity / signed provenance / clean-consumer installを検証しました。'
        ),
        (
            'v0.11 completion trancheはclose済みです。#6はseparate publication gateで、明示authorizationがある場合だけ実行し、source releaseから暗黙authorizeしません。',
            'v0.11 completion trancheはclose済みです。#6のseparate publication gateは `v1.0.0` に対して明示authorizeされ完了しました。今後のregistry releaseもsource releaseから暗黙authorizeせず、manual publication workflowを使います。'
        ),
    ],
}

for path, reps in replacements.items():
    p = Path(path)
    text = p.read_text()
    for old, new in reps:
        if old not in text:
            raise SystemExit(f'missing expected text in {path}: {old[:80]}')
        text = text.replace(old, new, 1)
    p.write_text(text)
