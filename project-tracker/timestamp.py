"""Utilitaire d'horodatage des tickets AlcheMix II — fuseau horaire Europe/Paris.

Convention : tout horodatage de ticket (tasks.json / journals.json / board.html) est
exprimé en temps local de Paris au format ISO 8601 avec décalage (ex. 2026-11-15T11:52:00+01:00),
plutôt qu'en UTC instancié ("Z"). Le fuseau gère automatiquement l'heure d'été (CEST, +02:00)
et l'heure d'hiver (CET, +01:00).
"""
from datetime import datetime
from zoneinfo import ZoneInfo


def get_paris_timestamp():
    """Récupère l'heure actuelle avec le fuseau horaire de Paris (été/hiver gérés automatiquement)."""
    paris_tz = ZoneInfo("Europe/Paris")
    now_paris = datetime.now(paris_tz)

    # Retourne au format ISO 8601 (ex: "2026-11-15T11:52:00+01:00")
    return now_paris.isoformat()


def parse_utc_to_paris(utc_iso, *, milliseconds=True):
    """Convertit un horodatage UTC (ex. '2026-11-15T10:50:00.000Z') en temps de Paris.

    Aide à migrer/aligner d'anciens horodatages "Z" vers la convention Europe/Paris
    (même instant, heure locale de Paris + décalage).
    """
    from datetime import datetime

    utc_dt = datetime.fromisoformat(utc_iso.replace("Z", "+00:00"))
    paris_dt = utc_dt.astimezone(ZoneInfo("Europe/Paris"))
    if milliseconds:
        return paris_dt.isoformat(timespec="milliseconds")
    return paris_dt.isoformat(timespec="seconds")


if __name__ == "__main__":
    # Exemple d'utilisation pour un nouveau ticket :
    print(get_paris_timestamp())