import { create } from 'zustand';

export type OnboardingFormData = {
  gender: 'male' | 'female';
  age: number;
  height_cm: number;
  weight_kg: number;
  target_weight_kg: number;
  activity_level: 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';
  goal_type: 'cut' | 'maintain';
  daily_deficit: number;
};

type ReviewState = {
  active: boolean;
  initialData: Partial<OnboardingFormData> | null;
  startReview: (data: Partial<OnboardingFormData>) => void;
  endReview: () => void;
};

export const useOnboardingReviewStore = create<ReviewState>((set) => ({
  active: false,
  initialData: null,
  startReview: (data) => set({ active: true, initialData: data }),
  endReview: () => set({ active: false, initialData: null }),
}));
