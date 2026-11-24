// ALC-270 : état reactif de la modale d'installation optionnelle « IA Chef d'Orchestre ».
// Un indicateur d'ouverture porté par un objet `$state` (assignable depuis l'extérieur), utilisé
// par BeatgridView « GÉNÉRER IA » et le premier lancement.

export const chefAiState = $state({ open: false });

export function openChefAiModal(): void {
  chefAiState.open = true;
}

export function closeChefAiModal(): void {
  chefAiState.open = false;
}