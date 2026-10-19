// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     UsersTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  Architecture.Tests
// =============================================

using System.Reflection;

using Architecture.Tests.Rules;

using UI.Components;

namespace Architecture.Tests;

public class UsersTests
{
	[Fact]
	public void UiAssembly_FeatureSlices_IncludeUsersWithNoCrossSliceDependencies()
	{
		// Arrange
		Assembly uiAssembly = typeof(App).Assembly;
		const string featuresNamespace = "UI.Components.Features";

		// Act
		IReadOnlyList<string> slices = SliceDependencyRule.FindSliceNames(uiAssembly, featuresNamespace);
		IReadOnlyList<string> crossSliceDependencies =
			SliceDependencyRule.FindCrossSliceDependencies(uiAssembly, featuresNamespace);

		// Assert
		slices.Should().Contain("Users");
		crossSliceDependencies.Should()
			.BeEmpty("each feature slice holds everything its use case needs, and depends on no other slice (ADR-0005)");
	}
}
