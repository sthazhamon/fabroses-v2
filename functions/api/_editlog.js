export async function logEdits(env, entityType, entityId, oldRow, changes, editedBy) {
  for (const [field, newValue] of Object.entries(changes)) {
    const oldValue = oldRow[field];
    if (String(oldValue ?? "") === String(newValue ?? "")) continue;
    await env.DB.prepare(
      `INSERT INTO edit_log (entity_type, entity_id, field, old_value, new_value, edited_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(entityType, entityId, field, oldValue === undefined ? null : String(oldValue ?? ""), String(newValue ?? ""), editedBy || "unknown").run();
  }
}
