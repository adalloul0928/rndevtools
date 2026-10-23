import { z } from 'zod';

export const updateStateSchema = z.object({
	status: z.enum([
		'unsupported',
		'idle',
		'checking',
		'current',
		'available',
		'downloading',
		'verifying',
		'ready',
		'installing',
		'error',
	]),
	currentVersion: z.string().max(64),
	version: z
		.string()
		.max(64)
		.regex(/^\d+\.\d+\.\d+$/)
		.optional(),
	percent: z.number().int().min(0).max(100).optional(),
	error: z.string().max(256).optional(),
});

export const updateOperationSchema = z.enum(['check', 'download', 'install']);
export type UpdateState = z.infer<typeof updateStateSchema>;
export type UpdateOperation = z.infer<typeof updateOperationSchema>;

export type UpdateBridge = {
	getUpdateState(): Promise<UpdateState>;
	runUpdateOperation(operation: UpdateOperation): Promise<UpdateState>;
	subscribeUpdateState(listener: (state: UpdateState) => void): () => void;
};
