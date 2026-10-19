// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     PublicApiExposureRuleTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  Architecture.Tests
// =============================================

using System.Reflection;

using Architecture.Tests.Fixtures.Exposure;

namespace Architecture.Tests.Rules;

public class PublicApiExposureRuleTests
{
	private const string FixturesExposureNamespace = "Architecture.Tests.Fixtures.Exposure";

	[Fact]
	public void FindTypesExposing_PublicMethodReturnsAForbiddenTypeInsideATask_ReturnsOnlyTheLeakyService()
	{
		// Arrange
		Assembly fixturesAssembly = typeof(LeakyService).Assembly;

		// Act
		IReadOnlyList<string> exposing = PublicApiExposureRule.FindTypesExposing(
			fixturesAssembly, FixturesExposureNamespace, "System.Net.Http");

		// Assert
		exposing.Should().Equal([typeof(LeakyService).FullName],
			"a forbidden type nested in a generic argument must be caught, and an internal member must not count, " +
			"proving the rule the ManagementApi test relies on fails on a violation");
	}

	[Fact]
	public void FindPublicTypes_FixtureNamespace_ReturnsTheVisibleTypesOnly()
	{
		// Arrange
		Assembly fixturesAssembly = typeof(LeakyService).Assembly;

		// Act
		IReadOnlyList<string> publicTypes = PublicApiExposureRule.FindPublicTypes(fixturesAssembly, FixturesExposureNamespace);

		// Assert
		publicTypes.Should().BeEquivalentTo([typeof(CleanService).FullName, typeof(LeakyService).FullName]);
	}
}
