// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     DomainTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  Architecture.Tests
// =============================================

using Domain;

namespace Architecture.Tests;

public class DomainTests
{
	[Theory]
	[InlineData("UI")]
	[InlineData("ServiceDefaults")]
	[InlineData("Microsoft.AspNetCore")]
	[InlineData("MongoDB")]
	public void DomainTypes_ForbiddenDependency_HaveNoDependencyOnIt(string forbiddenNamespace)
	{
		// Arrange
		Types domainTypes = Types.InAssembly(typeof(AssemblyMarker).Assembly);

		// Act
		NetArchTest.Rules.TestResult result = domainTypes
			.ShouldNot()
			.HaveDependencyOn(forbiddenNamespace)
			.GetResult();

		// Assert
		result.FailingTypeNames.Should().BeNullOrEmpty(
			"the Shared Kernel depends on nothing, so every feature can use it (see ADR-0001)");
	}
}
