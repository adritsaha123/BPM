"""Example CRUD resource. Rename/copy this for your real data model.

Stored in memory (resets on restart) — fine for a demo. Swap for SQLite or
Supabase later if you need persistence.
"""

from itertools import count

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/items", tags=["items"])

_db: dict[int, dict] = {}
_ids = count(1)


class ItemIn(BaseModel):
    title: str
    notes: str = ""


class Item(ItemIn):
    id: int


@router.get("", response_model=list[Item])
def list_items() -> list[Item]:
    return [Item(**v) for v in _db.values()]


@router.post("", response_model=Item, status_code=201)
def create_item(item: ItemIn) -> Item:
    new = Item(id=next(_ids), **item.model_dump())
    _db[new.id] = new.model_dump()
    return new


@router.delete("/{item_id}", status_code=204)
def delete_item(item_id: int) -> None:
    if _db.pop(item_id, None) is None:
        raise HTTPException(status_code=404, detail="Item not found")
