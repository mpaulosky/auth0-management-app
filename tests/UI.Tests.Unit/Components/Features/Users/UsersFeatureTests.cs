// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     UsersFeatureTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Unit
// =============================================

using FluentValidation;

using Microsoft.Extensions.DependencyInjection;

using UI.Components.Features.Users;
using UI.ManagementApi;

namespace UI.Tests.Unit.Components.Features.Users;

public class UsersFeatureTests
{
	[Fact]
	public void AddUsersFeature_Called_RegistersTheValidatorAndTheHandler()
	{
		// Arrange
		ServiceCollection services = new();

		// Act
		services.AddUsersFeature();

		// Assert
		services.Should().Contain(descriptor => descriptor.ServiceType == typeof(IValidator<SearchUsersQuery>) &&
		                                         descriptor.ImplementationType == typeof(SearchUsersQueryValidator));
		services.Should().Contain(descriptor => descriptor.ServiceType == typeof(SearchUsersHandler));
	}

	[Fact]
	public void AddUsersFeature_Called_AddsTheManagementApiSeam()
	{
		// Arrange
		ServiceCollection services = new();

		// Act
		services.AddUsersFeature();

		// Assert
		services.Should().ContainSingle(descriptor => descriptor.ServiceType == typeof(IManagementApi));
	}

	[Fact]
	public void AddUsersFeature_CalledWithAddManagementApi_RegistersTheSeamOnce()
	{
		// Arrange
		ServiceCollection services = new();
		services.AddManagementApi();

		// Act
		services.AddUsersFeature();

		// Assert
		services.Count(descriptor => descriptor.ServiceType == typeof(IManagementApi)).Should().Be(1);
	}

	[Fact]
	public void AddUsersFeature_Called_ReturnsTheSameServiceCollection()
	{
		// Arrange
		ServiceCollection services = new();

		// Act
		IServiceCollection returned = services.AddUsersFeature();

		// Assert
		returned.Should().BeSameAs(services);
	}
}
