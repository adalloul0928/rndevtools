import type { RecipeDefinition, RecipeStep } from '../shared/recipe-protocol';

function recipeStepRequiresRunApproval(step: RecipeStep): boolean {
	return (
		step.kind === 'slimming.mutation' ||
		(step.kind === 'restore-point' &&
			(step.operation === 'restore' || step.operation === 'remove')) ||
		(step.kind === 'simulator' &&
			(step.action.operation === 'keychain.reset' ||
				(step.action.operation === 'privacy.update' &&
					step.action.privacyOperation === 'reset')))
	);
}

export function recipeRequiresRunApproval(recipe: RecipeDefinition): boolean {
	return [...recipe.steps, ...recipe.teardown].some(
		recipeStepRequiresRunApproval
	);
}
