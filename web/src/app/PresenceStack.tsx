import { UsersRound } from "lucide-react";
import type { Presence, User } from "../api/types";
import { Popover } from "../ui/Popover";
import { Avatar } from "../ui/Avatar";
import styles from "./PresenceStack.module.css";

export function PresenceStack({ presence, users }: { presence: Presence; users: User[] }) {
  const members = presence.users
    .map((id) => users.find((user) => user.id === id))
    .filter((user): user is User => Boolean(user && !user.deleted));
  const guests = Math.max(0, Math.floor(Number(presence.guests) || 0));
  const limit = guests > 0 ? 4 : 5;
  const visible = members.slice(0, limit);
  const extra = members.slice(limit);
  if (!members.length && !guests) return null;
  return (
    <div className={styles.online} aria-label={`${members.length} 位登录用户在线${guests ? `，${guests} 位游客` : ""}`}>
      <span className={styles.stack}>
        {visible.map((user) => (
          <span key={user.id} className={styles.avatarButton} data-tooltip={user.username}>
            <Avatar name={user.username} avatar={user.avatar} online label={`${user.username}，在线`} />
          </span>
        ))}
        {extra.length ? (
          <Popover
            trigger={
              <button type="button" className={styles.more} aria-label={`另外 ${extra.length} 位在线用户`} aria-haspopup="dialog" data-tooltip={`另有 ${extra.length} 位在线用户`}>
                +{extra.length}
              </button>
            }
            align="end"
            className={styles.overflow}
          >
            {extra.map((user) => (
              <div key={user.id} className={styles.overflowRow} data-tooltip={user.username}>
                <Avatar name={user.username} avatar={user.avatar} online />
                <span>{user.username}</span>
              </div>
            ))}
          </Popover>
        ) : null}
      </span>
      {guests ? (
        <span className={styles.guestGroup} data-separated={members.length > 0}>
          <button type="button" className={styles.guests} data-tooltip={`${guests} 位未登录游客 · 只读`} aria-label={`${guests} 位游客在线`}>
            <UsersRound aria-hidden="true" />
            游客(x{guests})
          </button>
        </span>
      ) : null}
    </div>
  );
}
