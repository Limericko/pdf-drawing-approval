import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { activeUserRoles, type User, type UserRole } from "./repositories/users.ts";
import type { UserRepository } from "./repositories/users.ts";

export type AuthUser = Pick<User, "id" | "username" | "role" | "displayName">;

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function login(users: UserRepository, jwtSecret: string, username: string, password: string) {
  const user = users.findByUsername(username);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    throw new Error("INVALID_CREDENTIALS");
  }

  const payload: AuthUser = {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.displayName
  };

  return {
    token: jwt.sign(payload, jwtSecret, { expiresIn: "12h" }),
    user: payload
  };
}

export function requireAuth(jwtSecret: string, roles?: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization");
    const queryToken = typeof req.query.token === "string" ? req.query.token : null;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : queryToken;
    if (!token) return res.status(401).json({ error: "UNAUTHORIZED" });

    try {
      const user = jwt.verify(token, jwtSecret) as Partial<AuthUser>;
      if (!isActiveUserRole(user.role) || typeof user.id !== "number" || typeof user.username !== "string" || typeof user.displayName !== "string") {
        return res.status(401).json({ error: "UNAUTHORIZED" });
      }
      if (roles && !roles.includes(user.role)) {
        return res.status(403).json({ error: "FORBIDDEN" });
      }
      req.user = {
        id: user.id,
        username: user.username,
        role: user.role,
        displayName: user.displayName
      };
      next();
    } catch {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }
  };
}

function isActiveUserRole(role: unknown): role is UserRole {
  return typeof role === "string" && (activeUserRoles as readonly string[]).includes(role);
}
