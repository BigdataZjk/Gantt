create table if not exists metadata (
    id integer primary key check (id = 1),
    schema_version integer not null,
    revision integer not null,
    payload text not null
);
create table if not exists users (
    id text primary key,
    username text not null unique,
    role text not null check (role in ('superadmin', 'admin', 'collaborator', 'readonly')),
    disabled integer not null default 0,
    deleted integer not null default 0,
    password_hash text not null,
    password_cipher blob not null,
    avatar blob,
    avatar_type text not null default '',
    avatar_version text not null default '',
    preferences text not null default '{}'
);
create table if not exists sessions (
    token_hash text primary key,
    user_id text not null references users(id),
    expires_at integer not null
);
create index if not exists sessions_user on sessions(user_id);
create table if not exists history (
    id integer primary key autoincrement,
    actor text not null,
    action text not null,
    created_at text not null,
    reversible integer not null,
    undone integer not null default 0,
    before_data text
);
create table if not exists history_details (
    history_id integer primary key references history(id) on delete cascade,
    preview text not null,
    payload text not null
);
create table if not exists versions (
    id text primary key,
    label text not null,
    actor text not null,
    created_at text not null,
    revision integer not null,
    payload text not null
);

create table if not exists calendar_years (
    year integer primary key,
    payload text not null
);

create table if not exists system_settings (
    key text primary key,
    payload text not null
);
