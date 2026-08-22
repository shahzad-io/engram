-- Instrumentation is telemetry, not knowledge. These tables deliberately do
-- not carry graph validity windows and do not participate in graph versioning.

CREATE TABLE mcp_tool_calls (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id text,
  tool_name text NOT NULL,
  invoked_at timestamptz NOT NULL DEFAULT now(),
  graph_version bigint NOT NULL CHECK (graph_version >= 0),
  CONSTRAINT mcp_tool_calls_session_id_not_blank CHECK (
    session_id IS NULL OR length(session_id) > 0
  ),
  CONSTRAINT mcp_tool_calls_tool_name_not_blank CHECK (length(tool_name) > 0)
);

CREATE INDEX mcp_tool_calls_session_order
  ON mcp_tool_calls (session_id, id)
  WHERE session_id IS NOT NULL;

CREATE TABLE retrieval_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id text,
  tool_name text NOT NULL,
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  tier smallint CHECK (tier IS NULL OR tier BETWEEN 1 AND 3),
  tier_escalations text[] NOT NULL DEFAULT '{}',
  CONSTRAINT retrieval_events_session_id_not_blank CHECK (
    session_id IS NULL OR length(session_id) > 0
  ),
  CONSTRAINT retrieval_events_tool_name_not_blank CHECK (length(tool_name) > 0)
);

CREATE INDEX retrieval_events_time
  ON retrieval_events (retrieved_at);

CREATE TABLE relitigation_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  observed_at timestamptz NOT NULL DEFAULT now(),
  object_id text NOT NULL REFERENCES knowledge_objects (id),
  session_id text,
  pack_used boolean NOT NULL DEFAULT false,
  note text,
  CONSTRAINT relitigation_events_session_id_not_blank CHECK (
    session_id IS NULL OR length(session_id) > 0
  )
);

CREATE INDEX relitigation_events_object
  ON relitigation_events (object_id, observed_at);
