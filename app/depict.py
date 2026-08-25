"""RDKit depiction. Optional: without RDKit the app still runs, structures fall
back to the OCSR crop images in the UI."""

from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Any

try:  # pragma: no cover - exercised by the availability flag
    from rdkit import Chem, RDLogger
    from rdkit.Chem import Descriptors, rdMolDescriptors
    from rdkit.Chem.Draw import rdMolDraw2D

    RDLogger.DisableLog("rdApp.*")
    AVAILABLE = True
    IMPORT_ERROR: str | None = None
except Exception as exc:  # pragma: no cover
    AVAILABLE = False
    IMPORT_ERROR = f"{type(exc).__name__}: {exc}"

# Atom colours matched to the page palette so structures sit in the design
# rather than shouting CPK primaries at the reviewer.
LIGHT_PALETTE = {
    6: (0.13, 0.12, 0.11), 7: (0.25, 0.38, 0.60), 8: (0.71, 0.27, 0.18),
    16: (0.66, 0.53, 0.15), 9: (0.25, 0.49, 0.36), 17: (0.25, 0.49, 0.36),
    35: (0.55, 0.30, 0.15), 53: (0.45, 0.28, 0.55), 14: (0.42, 0.42, 0.40),
    15: (0.72, 0.45, 0.20), 5: (0.55, 0.45, 0.35),
}
DARK_PALETTE = {
    6: (0.91, 0.90, 0.87), 7: (0.53, 0.66, 0.87), 8: (0.88, 0.54, 0.44),
    16: (0.85, 0.72, 0.38), 9: (0.50, 0.75, 0.58), 17: (0.50, 0.75, 0.58),
    35: (0.80, 0.55, 0.35), 53: (0.70, 0.55, 0.80), 14: (0.66, 0.65, 0.62),
    15: (0.88, 0.65, 0.40), 5: (0.75, 0.65, 0.55),
}

_lock = threading.Lock()
_cache: "OrderedDict[str, str]" = OrderedDict()
_CACHE_MAX = 2000


def _cached(key: str) -> str | None:
    with _lock:
        value = _cache.get(key)
        if value is not None:
            _cache.move_to_end(key)
        return value


def _store(key: str, value: str) -> None:
    with _lock:
        _cache[key] = value
        while len(_cache) > _CACHE_MAX:
            _cache.popitem(last=False)


def placeholder_svg(width: int, height: int, message: str) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'width="{width}" height="{height}"><text x="50%" y="50%" text-anchor="middle" '
        f'dominant-baseline="middle" font-family="sans-serif" font-size="13" '
        f'fill="#b4442e">{message}</text></svg>'
    )


def render_svg(smiles: str, width: int, height: int, theme: str = "light", stereo: bool = True) -> str:
    if not AVAILABLE:
        return placeholder_svg(width, height, "RDKit unavailable")
    key = f"{smiles}|{width}x{height}|{theme}|{int(stereo)}"
    cached = _cached(key)
    if cached is not None:
        return cached
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        svg = placeholder_svg(width, height, "SMILES unparsable")
        _store(key, svg)
        return svg
    drawer = rdMolDraw2D.MolDraw2DSVG(width, height)
    options = drawer.drawOptions()
    options.clearBackground = False
    options.bondLineWidth = 1.7
    options.multipleBondOffset = 0.16
    options.padding = 0.07
    options.minFontSize = 11
    options.maxFontSize = 17
    options.addStereoAnnotation = bool(stereo)
    options.annotationFontScale = 0.62
    dark = theme == "dark"
    options.setAtomPalette(DARK_PALETTE if dark else LIGHT_PALETTE)
    options.setSymbolColour((0.91, 0.90, 0.87) if dark else (0.13, 0.12, 0.11))
    options.setAnnotationColour((0.62, 0.60, 0.56) if dark else (0.45, 0.43, 0.40))
    rdMolDraw2D.PrepareAndDrawMolecule(drawer, mol)
    drawer.FinishDrawing()
    svg = drawer.GetDrawingText()
    _store(key, svg)
    return svg


def properties(smiles: str) -> dict[str, Any]:
    if not AVAILABLE:
        return {"smiles": smiles, "valid": None, "error": "rdkit unavailable"}
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return {"smiles": smiles, "valid": False}
    return {
        "smiles": smiles,
        "valid": True,
        "canonical": Chem.MolToSmiles(mol),
        "formula": rdMolDescriptors.CalcMolFormula(mol),
        "mw": round(Descriptors.MolWt(mol), 2),
        "exact_mass": round(Descriptors.ExactMolWt(mol), 4),
        "heavy_atoms": mol.GetNumHeavyAtoms(),
        "rings": rdMolDescriptors.CalcNumRings(mol),
        "rotatable_bonds": rdMolDescriptors.CalcNumRotatableBonds(mol),
        "tpsa": round(rdMolDescriptors.CalcTPSA(mol), 1),
        "logp": round(Descriptors.MolLogP(mol), 2),
        "stereocenters": len(Chem.FindMolChiralCenters(mol, includeUnassigned=True, useLegacyImplementation=False)),
        "inchi_key": Chem.MolToInchiKey(mol) or None,
    }
