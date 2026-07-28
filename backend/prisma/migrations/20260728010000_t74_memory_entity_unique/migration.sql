-- T74 记忆失效通道：把冲突键从 (user_id, type, entity, content) 收窄到 (user_id, type, entity)
--
-- 旧键含 content，所以「最近3天排便不畅」和「排便已恢复正常」是两条独立的行——
-- repetition_count 不累加、旧措辞永远留在库里和新的打架，也和 MEMORY_SPEC §5.5
-- 「entity+type 命中已有记忆」的前提对不上。收窄后同 entity 走 DO UPDATE 覆盖 content。

-- 1. 合并现有同 (user_id, type, entity) 的多行：保留 (updated_at, id) 最大的一条，其余删除。
--    注意：这里必须是物理删除而不是软删（state='ARCHIVED'）——唯一约束不区分 state，
--    留着任何一行重复都建不出新索引。
DELETE FROM "UserMemory" m
WHERE EXISTS (
  SELECT 1 FROM "UserMemory" k
  WHERE k.user_id = m.user_id
    AND k.type = m.type
    AND k.entity = m.entity
    AND (k.updated_at, k.id) > (m.updated_at, m.id)
);

-- 2. 换索引
DROP INDEX IF EXISTS "UserMemory_user_id_type_entity_content_key";
CREATE UNIQUE INDEX "UserMemory_user_id_type_entity_key"
  ON "UserMemory"("user_id", "type", "entity");
