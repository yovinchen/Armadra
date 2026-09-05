import { z } from "zod";

export const timestampSchema = z.string().datetime({ offset: true });
